import { describe, expect, it } from "bun:test";
import {
  applyMaxHoursToResolution,
  BucketBot,
  resolveLiveStrikePrices,
} from "./bucket-bot.ts";
import type { BtcDailyEvent, BtcDailyStrike } from "./btc-daily.ts";

const noopLogger = { info() {}, warn() {}, error() {} } as never;

type FakeOrder = {
  status: string;
  sharesFilled?: string;
  positionId?: number | null;
  avgFillPrice?: string;
};
type FakeSlot = {
  orderId: number | null;
  positionId: number | null;
  limitPrice: number;
};

/** Build a BucketBot with a fake client + seeded `openByKey`, and expose the
 *  private cancel-on-block method. `getOrder` returns the order matching its
 *  call index when an array is given (to model a race fill on re-poll), else
 *  the single record. Only the fields the method reads are populated. */
function makeBotForCancel(opts: {
  dryRun?: boolean;
  getOrder: (id: number, call: number) => FakeOrder;
  slots: Record<string, FakeSlot>;
}) {
  const canceled: number[] = [];
  let call = 0;
  const client = {
    getOrder: async (id: number) => {
      call += 1;
      return { positionId: null, ...opts.getOrder(id, call) } as never;
    },
    cancelOrder: async (id: number) => {
      canceled.push(id);
    },
  } as never;
  const cfg = {
    stateFile: "/tmp/bucket-cancel-test.json",
    dryRun: opts.dryRun ?? false,
  } as never;
  const bot = new BucketBot(cfg, client, {} as never, noopLogger);
  (bot as unknown as { state: { openByKey: unknown } }).state.openByKey = {
    ...opts.slots,
  };
  return {
    // Both sides blocked unless a case narrows it.
    cancel: (
      blockBySide: unknown = { YES: { gate: "vol" }, NO: { gate: "vol" } },
    ) =>
      (
        bot as unknown as {
          cancelRestingOpensOnBlock: (g: unknown) => Promise<void>;
        }
      ).cancelRestingOpensOnBlock(blockBySide),
    openByKey: () =>
      (
        bot as unknown as {
          state: { openByKey: Record<string, FakeSlot | undefined> };
        }
      ).state.openByKey,
    canceled,
  };
}

describe("cancelRestingOpensOnBlock", () => {
  it("cancels a resting zero-fill open order and frees its slot", async () => {
    const h = makeBotForCancel({
      getOrder: () => ({ status: "RESTING", sharesFilled: "0" }),
      slots: { "k|m|NO": { orderId: 10, positionId: null, limitPrice: 0.99 } },
    });
    await h.cancel();
    expect(h.canceled).toEqual([10]);
    expect(h.openByKey()["k|m|NO"]).toBeUndefined();
  });

  it("never cancels a filled slot (positionId set) — leaves it riding", async () => {
    const h = makeBotForCancel({
      getOrder: () => {
        throw new Error("getOrder must not be called for a filled slot");
      },
      slots: { "k|m|NO": { orderId: 10, positionId: 555, limitPrice: 0.99 } },
    });
    await h.cancel();
    expect(h.canceled).toEqual([]);
    expect(h.openByKey()["k|m|NO"]).toBeDefined();
  });

  it("skips an order that already has fills (keeps slot, attaches positionId)", async () => {
    const h = makeBotForCancel({
      getOrder: () => ({
        status: "PARTIALLY_FILLED",
        sharesFilled: "5",
        positionId: 777,
        avgFillPrice: "0.99",
      }),
      slots: { "k|m|NO": { orderId: 10, positionId: null, limitPrice: 0.99 } },
    });
    await h.cancel();
    expect(h.canceled).toEqual([]);
    expect(h.openByKey()["k|m|NO"]?.positionId).toBe(777);
  });

  it("keeps the slot when the cancel lands AFTER a race fill", async () => {
    const h = makeBotForCancel({
      // 1st call (pre-cancel) = clean RESTING → cancel; 2nd (post-cancel) = filled.
      getOrder: (_id, call) =>
        call === 1
          ? { status: "RESTING", sharesFilled: "0" }
          : { status: "PARTIALLY_FILLED", sharesFilled: "3", positionId: 888 },
      slots: { "k|m|NO": { orderId: 10, positionId: null, limitPrice: 0.99 } },
    });
    await h.cancel();
    expect(h.canceled).toEqual([10]); // cancel was issued
    expect(h.openByKey()["k|m|NO"]?.positionId).toBe(888); // NOT freed
  });

  it("cancels only the blocked side's resting orders", async () => {
    const h = makeBotForCancel({
      getOrder: () => ({ status: "RESTING", sharesFilled: "0" }),
      slots: {
        "k|m|NO": { orderId: 10, positionId: null, limitPrice: 0.99 },
        "k|m|YES": { orderId: 11, positionId: null, limitPrice: 0.02 },
      },
    });
    await h.cancel({ YES: null, NO: { gate: "vol", side: "NO" } });
    expect(h.canceled).toEqual([10]);
    expect(h.openByKey()["k|m|NO"]).toBeUndefined();
    expect(h.openByKey()["k|m|YES"]).toBeDefined();
  });

  it("no-ops in dry-run", async () => {
    const h = makeBotForCancel({
      dryRun: true,
      getOrder: () => ({ status: "RESTING", sharesFilled: "0" }),
      slots: { "k|m|NO": { orderId: 10, positionId: null, limitPrice: 0.99 } },
    });
    await h.cancel();
    expect(h.canceled).toEqual([]);
    expect(h.openByKey()["k|m|NO"]).toBeDefined();
  });
});

function ev(slug: string, hoursFromNow: number, now: Date): BtcDailyEvent {
  const endDate = new Date(
    now.getTime() + hoursFromNow * 3_600_000,
  ).toISOString();
  return { slug, endDate, strikes: [] };
}

describe("applyMaxHoursToResolution", () => {
  const now = new Date("2026-05-25T12:00:00Z");

  it("returns input unchanged when maxHours is undefined", () => {
    const e = ev("evt-0", 50, now);
    const result = applyMaxHoursToResolution([e, null, e], now, undefined);
    expect(result.events).toEqual([e, null, e]);
    expect(result.skipped).toEqual([]);
  });

  it("keeps events resolving within cutoff", () => {
    const e1 = ev("near", 10, now);
    const e2 = ev("borderline", 36, now);
    const e3 = ev("at-cutoff", 36.0, now);
    const result = applyMaxHoursToResolution([e1, e2, e3], now, 36);
    expect(result.events).toEqual([e1, e2, e3]);
    expect(result.skipped).toEqual([]);
  });

  it("nulls out events past the cutoff", () => {
    const near = ev("today", 12, now);
    const far = ev("day-3", 60, now);
    const farther = ev("day-5", 120, now);
    const result = applyMaxHoursToResolution([near, far, farther], now, 36);
    expect(result.events).toEqual([near, null, null]);
    expect(result.skipped).toEqual(["day-3 (60.0h)", "day-5 (120.0h)"]);
  });

  it("preserves pre-existing nulls", () => {
    const e = ev("today", 6, now);
    const result = applyMaxHoursToResolution([e, null, null], now, 36);
    expect(result.events).toEqual([e, null, null]);
    expect(result.skipped).toEqual([]);
  });

  it("is inclusive at the cutoff boundary (events exactly at cutoff are kept)", () => {
    // exactly cutoffMs should be KEPT (<=), one ms past should be skipped
    const exact = ev("exact", 36, now);
    const past = ev("past", 36.001, now);
    const result = applyMaxHoursToResolution([exact, past], now, 36);
    expect(result.events[0]).toBe(exact);
    expect(result.events[1]).toBeNull();
  });

  it("works with fractional maxHours", () => {
    const within = ev("within", 12, now);
    const past = ev("past", 12.5001, now);
    const result = applyMaxHoursToResolution([within, past], now, 12.5);
    expect(result.events).toEqual([within, null]);
    expect(result.skipped[0]).toContain("past");
  });

  it("handles past-end_date events (already-resolved) as kept", () => {
    // negative hours = end_date in the past; still within cutoff (cutoff is positive)
    const stale = ev("stale", -2, now);
    const result = applyMaxHoursToResolution([stale], now, 36);
    expect(result.events[0]).toBe(stale);
    expect(result.skipped).toEqual([]);
  });
});

function strike(
  yesTokenId: string,
  noTokenId: string,
  yesPrice = 0.98,
  noPrice = 0.02,
): BtcDailyStrike {
  return {
    conditionId: `cond-${yesTokenId}`,
    slug: `slug-${yesTokenId}`,
    groupItemTitle: "80,000",
    strikeUsd: 80_000,
    yesTokenId,
    noTokenId,
    yesPrice,
    noPrice,
    closed: false,
  };
}

describe("resolveLiveStrikePrices", () => {
  const baseEvent: BtcDailyEvent = {
    slug: "btc-may-28",
    endDate: "2026-05-28T17:00:00Z",
    strikes: [strike("yes-1", "no-1"), strike("yes-2", "no-2")],
  };

  it("overlays live best-bid onto every strike (both sides resolved)", async () => {
    const live: Record<string, number> = {
      "yes-1": 0.04,
      "no-1": 0.95,
      "yes-2": 0.01,
      "no-2": 0.985,
    };
    const result = await resolveLiveStrikePrices(
      [baseEvent],
      async (id) => live[id] ?? null,
    );
    expect(result.droppedStrikes).toBe(0);
    expect(result.events[0]?.strikes).toHaveLength(2);
    expect(result.events[0]?.strikes[0]?.yesPrice).toBe(0.04);
    expect(result.events[0]?.strikes[0]?.noPrice).toBe(0.95);
    expect(result.events[0]?.strikes[1]?.yesPrice).toBe(0.01);
    expect(result.events[0]?.strikes[1]?.noPrice).toBe(0.985);
  });

  it("drops a strike when EITHER side's live bid is unavailable (no fallback)", async () => {
    const result = await resolveLiveStrikePrices([baseEvent], async (id) =>
      id === "no-1" ? null : 0.5,
    );
    expect(result.droppedStrikes).toBe(1);
    expect(result.events[0]?.strikes).toHaveLength(1);
    expect(result.events[0]?.strikes[0]?.yesTokenId).toBe("yes-2");
  });

  it("drops a strike when the resolver throws (no fallback)", async () => {
    const result = await resolveLiveStrikePrices([baseEvent], async (id) => {
      if (id === "yes-2") throw new Error("CLOB 500");
      return 0.5;
    });
    expect(result.droppedStrikes).toBe(1);
    expect(result.events[0]?.strikes).toHaveLength(1);
    expect(result.events[0]?.strikes[0]?.yesTokenId).toBe("yes-1");
  });

  it("preserves null events (already filtered upstream)", async () => {
    const result = await resolveLiveStrikePrices(
      [null, baseEvent],
      async () => 0.5,
    );
    expect(result.events[0]).toBeNull();
    expect(result.events[1]?.strikes).toHaveLength(2);
  });

  it("never reuses the strike's stale Gamma price as a fallback", async () => {
    // Strike's Gamma snapshot says yes=0.98 / no=0.02 — but the live resolver
    // returns null for the YES side. The strike must be dropped, NOT kept
    // with the stale Gamma value.
    const result = await resolveLiveStrikePrices(
      [{ ...baseEvent, strikes: [strike("yes-1", "no-1", 0.98, 0.02)] }],
      async (id) => (id === "yes-1" ? null : 0.95),
    );
    expect(result.droppedStrikes).toBe(1);
    expect(result.events[0]?.strikes).toHaveLength(0);
  });
});
