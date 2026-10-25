import { describe, expect, test } from "bun:test";
import { StrikeSignal, maxEntryPrice, takerFee, type Quote, type SignalConfig } from "./signal.ts";

const cfg: SignalConfig = {
  margin: 0.01,
  halfLifeSec: 60,
  cooldownSec: 60,
  minPrice: 0.9,
  maxPrice: 0.99,
  takerFeeRate: 0.07,
};

const quote = (sec: number, fairYes: number, bestBid = 0.94, bestAsk = 0.95): Quote => ({
  nowMs: sec * 1000,
  fairYes,
  bestBid,
  bestAsk,
  bidSize: 100,
  askSize: 40,
});

/** Feeds a steady market for `secs` seconds and returns the signal. */
function warmed(fairYes = 0.945, secs = 120): StrikeSignal {
  const s = new StrikeSignal(cfg);
  for (let t = 0; t <= secs; t++) expect(s.update(quote(t, fairYes))).toEqual([]);
  return s;
}

describe("StrikeSignal", () => {
  test("stays quiet until the baseline has warmed for one half-life", () => {
    const s = new StrikeSignal(cfg);
    expect(s.update(quote(0, 0.945))).toEqual([]);
    expect(s.update(quote(30, 0.99))).toEqual([]);
  });

  test("a persistent model bias never fires", () => {
    const s = warmed(0.99);
    expect(s.update(quote(121, 0.99))).toEqual([]);
  });

  test("a fresh jump in fair value buys YES at the ask", () => {
    const s = warmed();
    const [c] = s.update(quote(121, 0.98));
    expect(c!.side).toBe("YES");
    expect(c!.price).toBe(0.95);
    expect(c!.shares).toBe(40);
    // Judged against the baseline from before this reading: fair 0.98 minus
    // the steady 0 gap, not a baseline already pulled toward the jump.
    expect(c!.fair).toBeCloseTo(0.98, 6);
    expect(c!.edge).toBeCloseTo(0.98 - 0.95 - takerFee(0.95, 0.07), 6);
  });

  test("a fresh drop in fair value buys NO at one minus the bid", () => {
    // A steady 5c YES, so NO is offered at 1 − 0.05 = 0.95.
    const s = new StrikeSignal(cfg);
    for (let t = 0; t <= 120; t++) s.update(quote(t, 0.055, 0.05, 0.06));
    const [c] = s.update(quote(121, 0.02, 0.05, 0.06));
    expect(c!.side).toBe("NO");
    expect(c!.price).toBeCloseTo(0.95, 9);
    expect(c!.shares).toBe(100);
  });

  test("the taker fee and margin must both be covered", () => {
    const fee = takerFee(0.95, 0.07);
    const justShort = 0.95 + fee + cfg.margin - 0.0005;
    expect(warmed().update(quote(121, justShort))).toEqual([]);
    expect(warmed().update(quote(121, justShort + 0.001))).toHaveLength(1);
  });

  test("prices outside the band are ignored", () => {
    const s = new StrikeSignal(cfg);
    for (let t = 0; t <= 120; t++) s.update(quote(t, 0.805, 0.8, 0.81));
    expect(s.update(quote(121, 0.9, 0.8, 0.81))).toEqual([]);
  });

  test("a side stays quiet for the cooldown after a signal", () => {
    const s = warmed();
    expect(s.update(quote(121, 0.98))).toHaveLength(1);
    expect(s.update(quote(122, 0.99))).toEqual([]);
    expect(s.update(quote(182, 0.999))).toHaveLength(1);
  });

  test("a crossed or one-sided book is skipped", () => {
    const s = warmed();
    expect(s.update(quote(121, 0.98, 0.95, 0.95))).toEqual([]);
    expect(s.update(quote(122, 0.98, 0, 0.95))).toEqual([]);
  });
});

describe("maxEntryPrice", () => {
  test("is the price where the edge after fee is exactly the margin", () => {
    const p = maxEntryPrice(0.98, 0.01, 0.07);
    expect(0.98 - p - takerFee(p, 0.07)).toBeCloseTo(0.01, 12);
    expect(p).toBeGreaterThan(0.95);
  });

  test("with no fee it is fair minus the margin", () => {
    expect(maxEntryPrice(0.98, 0.01, 0)).toBeCloseTo(0.97, 12);
  });

  test("a signal carries it at or above the price it fired at", () => {
    const s = warmed();
    const [c] = s.update(quote(121, 0.98));
    expect(c!.maxLimit).toBeCloseTo(maxEntryPrice(0.98, 0.01, 0.07), 12);
    expect(c!.maxLimit).toBeGreaterThanOrEqual(c!.price);
  });
});
