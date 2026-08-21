import { describe, expect, it } from "bun:test";
import {
  allocate,
  priceToBucket,
  type AllocatorConfig,
  type Bucket,
} from "./allocator.ts";
import type { BtcDailyEvent, BtcDailyStrike } from "./btc-daily.ts";

function strike(args: {
  strikeUsd: number;
  yesPrice: number;
  slug?: string;
}): BtcDailyStrike {
  return {
    conditionId: `0xcid-${args.strikeUsd}`,
    slug: args.slug ?? `bitcoin-above-${args.strikeUsd}`,
    groupItemTitle: String(args.strikeUsd),
    strikeUsd: args.strikeUsd,
    yesTokenId: `y-${args.strikeUsd}`,
    noTokenId: `n-${args.strikeUsd}`,
    yesPrice: args.yesPrice,
    noPrice: 1 - args.yesPrice,
    closed: false,
  };
}

function event(strikes: BtcDailyStrike[], endDate: string): BtcDailyEvent {
  return { slug: "bitcoin-above-day", endDate, strikes };
}

const ALL_BUCKETS: ReadonlySet<Bucket> = new Set([
  "0.90-0.95",
  "0.95-0.97",
  "0.97-0.99",
  "0.99+",
]);

const baseCfg = (
  overrides: Partial<AllocatorConfig> = {},
): AllocatorConfig => ({
  totalCapitalUsd: 100,
  restricted: false,
  leveragePerBucket: {
    "0.90-0.95": 4,
    "0.95-0.97": 7,
    "0.97-0.99": 10,
    "0.99+": 10,
  },
  allowedBuckets: ALL_BUCKETS,
  dayWeights: [1],
  ...overrides,
});

describe("priceToBucket", () => {
  it("buckets prices < 0.90 and >= 1.0 as null (outside trading band)", () => {
    expect(priceToBucket(0.0)).toBe(null);
    expect(priceToBucket(0.5)).toBe(null);
    expect(priceToBucket(0.899)).toBe(null);
    expect(priceToBucket(1.0)).toBe(null);
    expect(priceToBucket(1.001)).toBe(null);
  });

  it("buckets 0.90 <= p < 0.95 as 0.90-0.95", () => {
    expect(priceToBucket(0.9)).toBe("0.90-0.95");
    expect(priceToBucket(0.92)).toBe("0.90-0.95");
    expect(priceToBucket(0.9499)).toBe("0.90-0.95");
  });

  it("buckets 0.95 <= p < 0.97 as 0.95-0.97", () => {
    expect(priceToBucket(0.95)).toBe("0.95-0.97");
    expect(priceToBucket(0.96)).toBe("0.95-0.97");
    expect(priceToBucket(0.9699)).toBe("0.95-0.97");
  });

  it("buckets 0.97 <= p < 0.99 as 0.97-0.99 (new)", () => {
    // This split was added when bucket-bot grew a 4th bucket so a more
    // confident leverage can sit on top of the 0.99+ band specifically.
    expect(priceToBucket(0.97)).toBe("0.97-0.99");
    expect(priceToBucket(0.98)).toBe("0.97-0.99");
    expect(priceToBucket(0.9899)).toBe("0.97-0.99");
  });

  it("buckets 0.99 <= p < 1.0 as 0.99+ (new)", () => {
    expect(priceToBucket(0.99)).toBe("0.99+");
    expect(priceToBucket(0.995)).toBe("0.99+");
    expect(priceToBucket(0.999)).toBe("0.99+");
  });
});

describe("allocate — maxEntryPrice gate", () => {
  it("drops strikes whose qualifying side >= maxEntryPrice", () => {
    const ev = event(
      [
        // BTC ~75k; YES below picks the qualifying side for low strikes.
        strike({ strikeUsd: 70_000, yesPrice: 0.92 }), // qualifies (below cap)
        strike({ strikeUsd: 72_000, yesPrice: 0.997 }), // dropped (>= 0.996)
        strike({ strikeUsd: 73_000, yesPrice: 0.999 }), // dropped (>= 0.996)
      ],
      new Date("2026-05-27T16:00:00Z").toISOString(),
    );
    const result = allocate([ev], [80_000], baseCfg({ maxEntryPrice: 0.996 }));
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]!.strikeUsd).toBe(70_000);
    expect(result.droppedMarkets).toHaveLength(2);
    expect(
      result.droppedMarkets.every((d) => d.reason === "max-entry-price"),
    ).toBe(true);
  });

  it("opens the high-bucket strike when no cap is set", () => {
    const ev = event(
      [strike({ strikeUsd: 70_000, yesPrice: 0.998 })],
      new Date("2026-05-27T16:00:00Z").toISOString(),
    );
    const result = allocate([ev], [80_000], baseCfg());
    expect(result.targets).toHaveLength(1);
    expect(result.droppedMarkets).toHaveLength(0);
  });
});

describe("allocate — ROI gate", () => {
  const eventAt = (hoursOut: number, p: number): BtcDailyEvent =>
    event(
      [strike({ strikeUsd: 70_000, yesPrice: p })],
      new Date(Date.now() + hoursOut * 3_600_000).toISOString(),
    );

  it("drops strikes whose leveraged ROI through resolution is below the floor", () => {
    // Entry 0.995, leverage 10, 24h to resolution, 30% APR.
    //   upside  = 10 × (1 − 0.995) / 0.995 ≈ 0.05025  (5.025%)
    //   interest = 9 × 0.30 × (24/8760)     ≈ 0.00740 (0.74%)
    //   roi      = 0.04285                              (4.285%)
    // floor 5% → dropped; floor 3% → kept.
    const ev = eventAt(24, 0.995);
    const cfgDropped = baseCfg({
      roiGate: { aprDecimal: 0.3, minRoi: 0.05, now: new Date() },
    });
    const cfgKept = baseCfg({
      roiGate: { aprDecimal: 0.3, minRoi: 0.03, now: new Date() },
    });
    expect(allocate([ev], [80_000], cfgDropped).targets).toHaveLength(0);
    expect(allocate([ev], [80_000], cfgKept).targets).toHaveLength(1);
  });

  it("a longer hold-to-resolution makes the gate fire on a strike that 24h passes", () => {
    // Same 0.995 entry: at 24h roi ≈ 4.29%; at 120h roi ≈ 1.34%.
    const cfg = baseCfg({
      roiGate: { aprDecimal: 0.3, minRoi: 0.02, now: new Date() },
    });
    expect(allocate([eventAt(24, 0.995)], [80_000], cfg).targets).toHaveLength(
      1,
    );
    expect(allocate([eventAt(120, 0.995)], [80_000], cfg).targets).toHaveLength(
      0,
    );
  });

  it("low-price strikes are unaffected — natural upside dominates interest", () => {
    // 0.92 yes: upside = 4 × 0.08 / 0.92 ≈ 34.8%. Interest can't catch that.
    const ev = eventAt(120, 0.92);
    const result = allocate(
      [ev],
      [80_000],
      baseCfg({
        roiGate: { aprDecimal: 0.3, minRoi: 0.02, now: new Date() },
      }),
    );
    expect(result.targets).toHaveLength(1);
  });
});

describe("allocate — per-bucket hours gates", () => {
  const eventAt = (hoursOut: number, p: number): BtcDailyEvent =>
    event(
      [strike({ strikeUsd: 70_000, yesPrice: p })],
      new Date(Date.now() + hoursOut * 3_600_000).toISOString(),
    );
  const noCap = {
    "0.90-0.95": undefined,
    "0.95-0.97": undefined,
    "0.97-0.99": undefined,
    "0.99+": undefined,
  };

  it("drops a deep-bucket strike opened beyond its per-bucket MAX, keeps it within", () => {
    // 0.98 yes (below current strike) → 0.97-0.99 bucket; cap it at 18h.
    const cfg = baseCfg({
      now: new Date(),
      maxHoursPerBucket: { ...noCap, "0.97-0.99": 18 },
    });
    const far = allocate([eventAt(20, 0.98)], [80_000], cfg);
    expect(far.targets).toHaveLength(0);
    expect(far.droppedMarkets[0]!.reason).toBe("max-hours");
    expect(allocate([eventAt(10, 0.98)], [80_000], cfg).targets).toHaveLength(
      1,
    );
  });

  it("a per-bucket cap only affects its own bucket", () => {
    // Deep cap at 18h, but a 0.92 (shallow 0.90-0.95) strike at 20h has no cap.
    const cfg = baseCfg({
      now: new Date(),
      maxHoursPerBucket: { ...noCap, "0.97-0.99": 18 },
    });
    expect(allocate([eventAt(20, 0.92)], [80_000], cfg).targets).toHaveLength(
      1,
    );
  });

  it("drops a strike opened too close to resolution (per-bucket MIN)", () => {
    const cfg = baseCfg({
      now: new Date(),
      minHoursPerBucket: { ...noCap, "0.97-0.99": 3 },
    });
    const tooClose = allocate([eventAt(1, 0.98)], [80_000], cfg);
    expect(tooClose.targets).toHaveLength(0);
    expect(tooClose.droppedMarkets[0]!.reason).toBe("min-hours");
    expect(allocate([eventAt(6, 0.98)], [80_000], cfg).targets).toHaveLength(1);
  });

  it("hours gates are inert when no reference time is available", () => {
    // No `now` and no roiGate → hoursToResolution can't be computed → no cap.
    const cfg = baseCfg({ maxHoursPerBucket: { ...noCap, "0.97-0.99": 18 } });
    expect(allocate([eventAt(48, 0.98)], [80_000], cfg).targets).toHaveLength(
      1,
    );
  });
});

describe("allocate — per-position cap", () => {
  it("caps each target's collateral, leaving surplus undeployed", () => {
    const ev = event(
      [
        strike({ strikeUsd: 70_000, yesPrice: 0.91 }),
        strike({ strikeUsd: 71_000, yesPrice: 0.93 }),
      ],
      new Date("2026-05-27T16:00:00Z").toISOString(),
    );
    // Day budget = 100, 2 strikes → 50 each. Cap at 30 → both clamped.
    const result = allocate(
      [ev],
      [80_000],
      baseCfg({ maxPositionCollateralUsd: 30 }),
    );
    expect(result.targets).toHaveLength(2);
    for (const t of result.targets) expect(t.collateralUsd).toBe(30);
    expect(result.daySummaries[0]!.deployedUsd).toBe(60);
  });

  it("no clamp applies when per-position cap is above the natural share", () => {
    const ev = event(
      [
        strike({ strikeUsd: 70_000, yesPrice: 0.91 }),
        strike({ strikeUsd: 71_000, yesPrice: 0.93 }),
      ],
      new Date("2026-05-27T16:00:00Z").toISOString(),
    );
    const result = allocate(
      [ev],
      [80_000],
      baseCfg({ maxPositionCollateralUsd: 1_000 }),
    );
    for (const t of result.targets) expect(t.collateralUsd).toBe(50);
  });
});
