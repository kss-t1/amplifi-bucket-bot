import { describe, expect, it } from "bun:test";
import {
  applyMaxHoursToResolution,
  BucketBot,
  resolveLiveStrikePrices,
} from "./bucket-bot.ts";
import type { BtcDailyEvent, BtcDailyStrike } from "./btc-daily.ts";
import type { PricePoint } from "../../common/src/vol-gate.ts";
import { measure } from "../../common/src/headroom-gate.ts";

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
      blockBySide: Record<string, unknown> = {
        YES: { gate: "vol" },
        NO: { gate: "vol" },
      },
    ) =>
      (
        bot as unknown as {
          cancelRestingOpens: (
            f: (key: string, slot: unknown) => unknown,
          ) => Promise<void>;
        }
      ).cancelRestingOpens(
        (key) =>
          blockBySide[key.split("|")[2] === "YES" ? "YES" : "NO"] ?? null,
      ),
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

/** Build a bot whose vol gate serves a fixed price history, and expose the
 *  private headroom check. The walk must not repeat hourly or every hourly
 *  return is zero and the fixture measures no volatility at all. */
function makeBotForHeadroom(opts: {
  enabled: boolean;
  k?: number;
  timeExponent?: number;
}) {
  const MIN = 60_000;
  const END = 100_000_000;
  const prices: PricePoint[] = [];
  let x = 100;
  for (let i = 399; i >= 0; i--) {
    const r = Math.sin((399 - i) * 12.9898) * 43758.5453;
    x *= 1 + (r - Math.floor(r) - 0.5) * 0.004;
    prices.push({ ts: END - i * 5 * MIN, price: x });
  }
  const cfg = {
    stateFile: "/tmp/bucket-headroom-test.json",
    dryRun: true,
    headroomGateEnabled: opts.enabled,
    headroomK: opts.k ?? 7,
    headroomTimeExponent: opts.timeExponent ?? 0,
  } as never;
  const bot = new BucketBot(cfg, {} as never, {} as never, noopLogger);
  (bot as unknown as { volGate: unknown }).volGate = {
    prices: () => prices,
  };
  const spot = prices[prices.length - 1]!.price;
  return {
    spot,
    checkKnown: (strikeUsd: number, outcome: "YES" | "NO") =>
      (
        bot as unknown as {
          checkHeadroomFor: (
            marketSlug: string,
            outcome: "YES" | "NO",
            events: unknown,
            now: Date,
            vol: unknown,
            knownStrikeUsd?: number,
            eventSlug?: string,
          ) => Record<string, unknown> | null;
        }
      ).checkHeadroomFor(
        "gone",
        outcome,
        [],
        new Date(END),
        measure(prices),
        strikeUsd,
        "gone",
      ),
    check: (
      strikeUsd: number,
      outcome: "YES" | "NO",
      endMs: number,
      events?: unknown,
    ) =>
      (
        bot as unknown as {
          checkHeadroom: (
            t: unknown,
            events: unknown,
            now: Date,
            vol: unknown,
          ) => Record<string, unknown> | null;
        }
      ).checkHeadroom(
        { marketSlug: "bitcoin-above-Xk", outcome, dayIndex: 0 },
        events ?? [
          {
            endDate: new Date(endMs).toISOString(),
            strikes: [{ slug: "bitcoin-above-Xk", strikeUsd }],
          },
        ],
        new Date(END),
        measure(prices),
      ),
  };
}

describe("checkHeadroom", () => {
  const SIX_HOURS = 6 * 3_600_000;

  it("is inert when the gate is disabled", () => {
    const h = makeBotForHeadroom({ enabled: false });
    expect(h.check(h.spot + 0.1, "NO", 100_000_000 + SIX_HOURS)).toBeNull();
  });

  it("blocks a strike sitting inside the required cushion", () => {
    const h = makeBotForHeadroom({ enabled: true });
    const d = h.check(h.spot * 1.002, "NO", 100_000_000 + SIX_HOURS)!;
    expect(d.block).toBe(true);
    expect(d.gate).toBeUndefined();
    expect(d.hoursToResolution).toBeCloseTo(6, 3);
  });

  it("allows a strike well outside it", () => {
    const h = makeBotForHeadroom({ enabled: true });
    expect(h.check(h.spot * 2, "NO", 100_000_000 + SIX_HOURS)!.block).toBe(
      false,
    );
  });

  it("derives hours-to-resolution from the day's event", () => {
    const h = makeBotForHeadroom({ enabled: true });
    const d = h.check(h.spot * 2, "NO", 100_000_000 + 18 * 3_600_000)!;
    expect(d.hoursToResolution).toBeCloseTo(18, 3);
  });

  it("returns null when the day has no event", () => {
    const h = makeBotForHeadroom({ enabled: true });
    const strike = h.spot * 1.002; // would otherwise block
    expect(h.check(strike, "NO", 0, [null])).toBeNull();
    expect(h.check(strike, "NO", 0, [])).toBeNull();
  });

  it("checks a slot whose event is gone, using the strike it carries", () => {
    const bot = makeBotForHeadroom({ enabled: true });
    const res = bot.checkKnown(bot.spot * 1.002, "NO");
    expect(res!.block).toBe(true);
    expect(res!.hoursToResolution).toBeNull();
  });

  it("returns null when no event lists that market slug", () => {
    const h = makeBotForHeadroom({ enabled: true });
    expect(
      h.check(h.spot * 1.002, "NO", 0, [
        {
          endDate: new Date(100_000_000 + SIX_HOURS).toISOString(),
          strikes: [{ slug: "some-other-market", strikeUsd: 1 }],
        },
      ]),
    ).toBeNull();
  });
});

describe("headroom cancels resting orders whose cushion has gone", () => {
  const MIN = 60_000;
  const END = 100_000_000;
  const SIX_HOURS = 6 * 3_600_000;

  /** A bot with the headroom gate on, a fixed price feed, and two resting
   *  zero-fill orders: one on a strike that is now far too close, one safe. */
  function harness() {
    const prices: { ts: number; price: number }[] = [];
    let x = 100;
    for (let i = 399; i >= 0; i--) {
      const r = Math.sin((399 - i) * 12.9898) * 43758.5453;
      x *= 1 + (r - Math.floor(r) - 0.5) * 0.004;
      prices.push({ ts: END - i * 5 * MIN, price: x });
    }
    const spot = prices[prices.length - 1]!.price;
    const canceled: number[] = [];
    const client = {
      getOrder: async () => ({
        status: "RESTING",
        sharesFilled: "0",
        positionId: null,
      }),
      cancelOrder: async (id: number) => {
        canceled.push(id);
      },
    } as never;
    const cfg = {
      stateFile: "/tmp/bucket-headroom-cancel-test.json",
      dryRun: false,
      headroomGateEnabled: true,
      headroomK: 7,
      headroomTimeExponent: 0,
    } as never;
    const bot = new BucketBot(cfg, client, {} as never, noopLogger);
    (bot as unknown as { volGate: unknown }).volGate = {
      prices: () => prices.map((p) => ({ ...p })),
    };
    (
      bot as unknown as { state: { openByKey: Record<string, unknown> } }
    ).state.openByKey = {
      "e|near|NO": {
        key: "e|near|NO",
        marketSlug: "near",
        outcome: "NO",
        orderId: 10,
        positionId: null,
        limitPrice: 0.99,
      },
      "e|far|NO": {
        key: "e|far|NO",
        marketSlug: "far",
        outcome: "NO",
        orderId: 11,
        positionId: null,
        limitPrice: 0.99,
      },
    };
    const events = [
      {
        endDate: new Date(END + SIX_HOURS).toISOString(),
        strikes: [
          { slug: "near", strikeUsd: spot * 1.002 },
          { slug: "far", strikeUsd: spot * 2 },
        ],
      },
    ];
    return {
      canceled,
      openByKey: () =>
        (bot as unknown as { state: { openByKey: Record<string, unknown> } })
          .state.openByKey,
      sweep: () =>
        (
          bot as unknown as {
            cancelRestingOpens: (f: unknown) => Promise<void>;
            headroomCancelReason: (e: unknown, n: Date, v: unknown) => unknown;
          }
        ).cancelRestingOpens(
          (
            bot as unknown as {
              headroomCancelReason: (
                e: unknown,
                n: Date,
                v: unknown,
              ) => unknown;
            }
          ).headroomCancelReason(events, new Date(END), measure(prices)),
        ),
    };
  }

  it("cancels the order whose strike is now inside the cushion", async () => {
    const h = harness();
    await h.sweep();
    expect(h.canceled).toEqual([10]);
    expect(h.openByKey()["e|near|NO"]).toBeUndefined();
  });

  it("leaves the order with plenty of cushion resting", async () => {
    const h = harness();
    await h.sweep();
    expect(h.canceled).not.toContain(11);
    expect(h.openByKey()["e|far|NO"]).toBeDefined();
  });
});

/** Headroom EXIT sweep: filled positions whose cushion has gone get closed;
 *  ones that still clear the (scaled) requirement are left riding. */
function makeBotForHeadroomExit(opts: {
  exitFactor: number;
  failClose?: boolean;
  /** Close returns OK but the position is still OPEN afterwards. */
  closeUnconfirmed?: boolean;
  dryRun?: boolean;
  /** Extra filled slots, keyed by market slug, to test the per-cycle cap. */
  extraNear?: number;
  exitEnabled?: boolean;
}) {
  const MIN = 60_000;
  const END = 100_000_000;
  const SIX_HOURS = 6 * 60 * MIN;
  const prices: PricePoint[] = [];
  let x = 100;
  for (let i = 399; i >= 0; i--) {
    const r = Math.sin((399 - i) * 12.9898) * 43758.5453;
    x *= 1 + (r - Math.floor(r) - 0.5) * 0.004;
    prices.push({ ts: END - i * 5 * MIN, price: x });
  }
  const spot = prices[prices.length - 1]!.price;
  const closed: number[] = [];
  const client = {
    closePosition: async (id: number) => {
      if (opts.failClose) throw new Error("close blew up");
      closed.push(id);
      return { status: "ok" };
    },
    // Confirms the close unless the fixture asks for a stuck position.
    getPosition: async () =>
      opts.closeUnconfirmed ? { status: "OPEN" } : { status: "CLOSED" },
  } as never;
  const cfg = {
    stateFile: "/tmp/bucket-headroom-exit-test.json",
    dryRun: opts.dryRun ?? false,
    headroomGateEnabled: true,
    headroomK: 7,
    headroomTimeExponent: 0,
    headroomExitEnabled: opts.exitEnabled ?? true,
    headroomExitFactor: opts.exitFactor,
  } as never;
  const bot = new BucketBot(cfg, client, {} as never, noopLogger);
  (bot as unknown as { volGate: unknown }).volGate = {
    prices: () => prices.map((p) => ({ ...p })),
  };
  const slots: Record<string, unknown> = {
    // Filled position sitting very close to its strike.
    "e|near|NO": {
      key: "e|near|NO",
      marketSlug: "near",
      outcome: "NO",
      orderId: 10,
      positionId: 500,
      limitPrice: 0.99,
    },
    // Filled position with a huge cushion.
    "e|far|NO": {
      key: "e|far|NO",
      marketSlug: "far",
      outcome: "NO",
      orderId: 11,
      positionId: 501,
      limitPrice: 0.99,
    },
    // Still only a resting order — the exit sweep must never touch it.
    "e|near2|NO": {
      key: "e|near2|NO",
      marketSlug: "near",
      outcome: "NO",
      orderId: 12,
      positionId: null,
      limitPrice: 0.99,
    },
  };
  const strikes = [
    { slug: "near", strikeUsd: spot * 1.002 },
    { slug: "far", strikeUsd: spot * 2 },
  ];
  // Extra doomed slots, each a tiny bit further from the strike than the last,
  // so the sweep's worst-first ordering is observable.
  for (let i = 0; i < (opts.extraNear ?? 0); i++) {
    const slug = `near-${i}`;
    slots[`e|${slug}|NO`] = {
      key: `e|${slug}|NO`,
      marketSlug: slug,
      outcome: "NO",
      orderId: 100 + i,
      positionId: 600 + i,
      limitPrice: 0.99,
    };
    // Deliberately DESCENDING cushion with index, so insertion order is the
    // reverse of the order the sweep must produce.
    strikes.push({
      slug,
      strikeUsd: spot * (1.003 + ((opts.extraNear ?? 0) - 1 - i) * 0.0005),
    });
  }
  (
    bot as unknown as { state: { openByKey: Record<string, unknown> } }
  ).state.openByKey = slots;
  const events = [
    { endDate: new Date(END + SIX_HOURS).toISOString(), strikes },
  ];
  const vol = measure(prices);
  return {
    closed,
    spot,
    run: () =>
      (
        bot as unknown as {
          closeLostHeadroom: (
            e: unknown,
            now: Date,
            vol: unknown,
          ) => Promise<void>;
        }
      ).closeLostHeadroom(events as never, new Date(END), vol as never),
    /** The entry-side check, to prove it shares the exit's threshold. */
    entryCheck: (strikeUsd: number) =>
      (
        bot as unknown as {
          checkHeadroom: (
            t: unknown,
            e: unknown,
            now: Date,
            vol: unknown,
          ) => Record<string, unknown> | null;
        }
      ).checkHeadroom(
        { marketSlug: "x", outcome: "NO", strikeUsd, eventSlug: "e" } as never,
        events as never,
        new Date(END),
        vol as never,
      ),
    /** Re-run with `near` moved far from its strike, to prove recovery. */
    runWithRoomyStrike: () => {
      strikes[0]!.strikeUsd = spot * 2;
      return (
        bot as unknown as {
          closeLostHeadroom: (
            e: unknown,
            now: Date,
            vol: unknown,
          ) => Promise<void>;
        }
      ).closeLostHeadroom(events as never, new Date(END), vol as never);
    },
    slots: () =>
      (bot as unknown as { state: { openByKey: Record<string, unknown> } })
        .state.openByKey,
  };
}

describe("headroom exit sweep", () => {
  it("closes a filled position whose cushion has gone, keeps the roomy one", async () => {
    const h = makeBotForHeadroomExit({ exitFactor: 1 });
    await h.run();
    expect(h.closed).toEqual([500]);
  });

  it("marks rather than deletes, so the allocator cannot re-open the same market", async () => {
    const h = makeBotForHeadroomExit({ exitFactor: 1 });
    await h.run();
    const slot = h.slots()["e|near|NO"] as { headroomExited?: boolean };
    expect(slot).toBeDefined();
    expect(slot.headroomExited).toBe(true);
    // A marked slot is not re-swept on the next cycle.
    await h.run();
    expect(h.closed).toEqual([500]);
  });

  it("never touches a slot that is still only a resting order", async () => {
    const h = makeBotForHeadroomExit({ exitFactor: 1 });
    await h.run();
    expect(h.closed).not.toContain(12);
    const resting = h.slots()["e|near2|NO"] as { headroomExited?: boolean };
    expect(resting.headroomExited).toBeUndefined();
  });

  it("a smaller exit factor holds a position the entry rule would refuse", async () => {
    const h = makeBotForHeadroomExit({ exitFactor: 0.01 });
    await h.run();
    expect(h.closed).toEqual([]);
  });

  it("keeps the slot unmarked when the close fails, so the next cycle retries", async () => {
    const h = makeBotForHeadroomExit({ exitFactor: 1, failClose: true });
    await h.run();
    expect(h.closed).toEqual([]);
    const slot = h.slots()["e|near|NO"] as { headroomExited?: boolean };
    expect(slot).toBeDefined();
    expect(slot.headroomExited).toBeUndefined();
  });

  it("caps closes per cycle", async () => {
    const h = makeBotForHeadroomExit({ exitFactor: 1, extraNear: 10 });
    await h.run();
    expect(h.closed).toHaveLength(5);
    await h.run();
    expect(h.closed).toHaveLength(10);
  });

  it("closes the worst cushion first, against reversed insertion order", async () => {
    const h = makeBotForHeadroomExit({ exitFactor: 1, extraNear: 4 });
    await h.run();
    // Extras are inserted with DESCENDING urgency, so a missing sort would
    // yield [500, 600, 601, 602, 603]; the correct order reverses the tail.
    expect(h.closed).toEqual([500, 603, 602, 601, 600]);
  });

  it("does nothing when the sweep is disabled", async () => {
    const h = makeBotForHeadroomExit({ exitFactor: 1, exitEnabled: false });
    await h.run();
    expect(h.closed).toEqual([]);
  });

  it("clears the failure count once the cushion recovers", async () => {
    const h = makeBotForHeadroomExit({ exitFactor: 1, failClose: true });
    await h.run();
    const slot = h.slots()["e|near|NO"] as { headroomExitAttempts?: number };
    expect(slot.headroomExitAttempts).toBe(1);
    // Same slot, now far from its strike: the sweep must forget the failure.
    await h.runWithRoomyStrike();
    expect(slot.headroomExitAttempts).toBe(0);
  });

  it("logs the decision without closing in dry run", async () => {
    const h = makeBotForHeadroomExit({ exitFactor: 1, dryRun: true });
    await h.run();
    expect(h.closed).toEqual([]);
    const slot = h.slots()["e|near|NO"] as { headroomExited?: boolean };
    expect(slot.headroomExited).toBeUndefined();
  });

  it("raises the ENTRY bar to the exit threshold, so it cannot re-open what it just closed", async () => {
    // The probe must sit BETWEEN the two thresholds or the test cannot fail:
    // at k=7 the requirement is ~2.2% and at k=10.5 (factor 1.5) it is ~3.3%,
    // so a 2.5% cushion is admitted by the entry rule alone and refused only
    // when the exit factor is folded in.
    // Fixture vol is 0.316%/hr => required 2.212% at k=7, 3.318% at k=10.5.
    // A 2.5% cushion therefore clears the entry rule on its own and is refused
    // only once the exit factor is folded in. Probe outside that band and the
    // test passes with the coupling deleted.
    const h = makeBotForHeadroomExit({ exitFactor: 1.5 });
    const coupled = h.entryCheck(h.spot * 1.025);
    expect(coupled?.headroomPct as number).toBeCloseTo(2.5, 1);
    expect(coupled?.requiredPct as number).toBeCloseTo(3.318, 1);
    expect(coupled?.block).toBe(true);
  });

  it("leaves the entry bar alone when the sweep is off", async () => {
    const h = makeBotForHeadroomExit({ exitFactor: 1.5, exitEnabled: false });
    const uncoupled = h.entryCheck(h.spot * 1.025);
    expect(uncoupled?.requiredPct as number).toBeCloseTo(2.212, 1);
    expect(uncoupled?.block).toBe(false);
  });

  it("does not latch when the position is still open after the close", async () => {
    const h = makeBotForHeadroomExit({ exitFactor: 1, closeUnconfirmed: true });
    await h.run();
    expect(h.closed).toEqual([500]);
    const slot = h.slots()["e|near|NO"] as {
      headroomExited?: boolean;
      headroomExitAttempts?: number;
    };
    expect(slot.headroomExited).toBeUndefined();
    expect(slot.headroomExitAttempts).toBe(1);
  });

  it("stops retrying a slot after repeated failures", async () => {
    const h = makeBotForHeadroomExit({ exitFactor: 1, failClose: true });
    for (let i = 0; i < 7; i++) await h.run();
    const slot = h.slots()["e|near|NO"] as { headroomExitAttempts?: number };
    expect(slot.headroomExitAttempts).toBe(5);
  });
});
