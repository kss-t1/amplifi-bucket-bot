import { describe, expect, it } from "bun:test";
import {
  chooseTpDecision,
  computeFixedTpPrice,
  computeTpPrice,
  DEFAULT_TP_PRICE,
  tpAnchorPrice,
} from "./tp.ts";

describe("computeTpPrice", () => {
  it("ROE math: 5% ROE on 4x at fill 0.92 → 0.932 (ceiled from 0.9315)", () => {
    // tp_raw = 0.92 × (1 + 0.05/4) = 0.9315 → ceil to next 0.001 tick = 0.932.
    const res = computeTpPrice({
      fillPrice: 0.92,
      leverage: 4,
      roePct: 5,
      tickSize: 0.001,
    });
    expect(res.kind).toBe("set");
    if (res.kind !== "set") throw new Error("unreachable");
    expect(res.tpPrice).toBeCloseTo(0.932, 4);
  });

  it("ROE math: 10% ROE on 10x at fill 0.97 → ceil to next tick", () => {
    // tp_raw = 0.97 × (1 + 0.10/10) = 0.9797 → ceil to 0.980 at 0.001 tick.
    const res = computeTpPrice({
      fillPrice: 0.97,
      leverage: 10,
      roePct: 10,
      tickSize: 0.001,
    });
    expect(res.kind).toBe("set");
    if (res.kind !== "set") throw new Error("unreachable");
    expect(res.tpPrice).toBeCloseTo(0.98, 4);
  });

  it("rounds up to tick so TP is always strictly above fillPrice", () => {
    // tp_raw = 0.9301 → must ceil up, not down — otherwise TP ≤ fill.
    const res = computeTpPrice({
      fillPrice: 0.93,
      leverage: 100,
      roePct: 0.1,
      tickSize: 0.01,
    });
    expect(res.kind).toBe("set");
    if (res.kind !== "set") throw new Error("unreachable");
    expect(res.tpPrice).toBeGreaterThan(0.93);
    expect(res.tpPrice).toBeCloseTo(0.94, 4);
  });

  it("skips when ROE × leverage overshoots 1.0", () => {
    // tp_raw = 0.99 × (1 + 50/4) = 13.365 → way past 1.0 → skip.
    const res = computeTpPrice({
      fillPrice: 0.99,
      leverage: 4,
      roePct: 50,
      tickSize: 0.001,
    });
    expect(res.kind).toBe("skip");
    if (res.kind !== "skip") throw new Error("unreachable");
    expect(res.reason).toBe("out-of-range");
  });

  it("skips when ceil leaves TP equal to or below fillPrice on coarse tick", () => {
    // tp_raw = 0.99 × (1 + 0.001/100) ≈ 0.9900099 → ceil@0.01 → 0.99 ≤ fill → skip.
    const res = computeTpPrice({
      fillPrice: 0.99,
      leverage: 100,
      roePct: 0.001,
      tickSize: 0.01,
    });
    expect(res.kind).toBe("skip");
  });

  it("respects the (0, 1) CLOB bound (cap at 1 − tickSize)", () => {
    // 0.999 at 0.001 tick is already at the cap; any positive ROE pushes
    // past 1.0 → skip.
    const res = computeTpPrice({
      fillPrice: 0.999,
      leverage: 1,
      roePct: 1,
      tickSize: 0.001,
    });
    expect(res.kind).toBe("skip");
  });
});

describe("computeFixedTpPrice", () => {
  it("snaps to tick and lands at the requested 0.999 on 0.001-tick books", () => {
    const res = computeFixedTpPrice({
      fillPrice: 0.92,
      targetPrice: DEFAULT_TP_PRICE,
      tickSize: 0.001,
    });
    expect(res.kind).toBe("set");
    if (res.kind !== "set") throw new Error("unreachable");
    expect(res.tpPrice).toBeCloseTo(0.999, 4);
  });

  it("floors to tick on coarse books (0.01 tick → 0.99 cap)", () => {
    // 1 − 0.01 = 0.99 is the CLOB cap on a 0.01 tick; we want at most 0.999
    // but never above the cap, so floor-to-tick lands on 0.99.
    const res = computeFixedTpPrice({
      fillPrice: 0.9,
      targetPrice: DEFAULT_TP_PRICE,
      tickSize: 0.01,
    });
    expect(res.kind).toBe("set");
    if (res.kind !== "set") throw new Error("unreachable");
    expect(res.tpPrice).toBeCloseTo(0.99, 4);
  });

  it("skips when fillPrice is already at or above the target", () => {
    const res = computeFixedTpPrice({
      fillPrice: 0.999,
      targetPrice: DEFAULT_TP_PRICE,
      tickSize: 0.001,
    });
    expect(res.kind).toBe("skip");
    if (res.kind !== "skip") throw new Error("unreachable");
    expect(res.reason).toBe("out-of-range");
  });

  it("skips when coarse-tick floor drops at or below fillPrice", () => {
    // 0.01 tick floors 0.999 → 0.99; if fillPrice is 0.99 the TP would
    // sit at-fill, which the CLOB rejects.
    const res = computeFixedTpPrice({
      fillPrice: 0.99,
      targetPrice: DEFAULT_TP_PRICE,
      tickSize: 0.01,
    });
    expect(res.kind).toBe("skip");
  });
});

describe("chooseTpDecision", () => {
  it("uses the ROE price when it lands in range", () => {
    // fill 0.92, lev 4, 5% ROE → 0.932 (same as computeTpPrice).
    const res = chooseTpDecision({
      fillPrice: 0.92,
      leverage: 4,
      roePct: 5,
      tickSize: 0.001,
    });
    expect(res.kind).toBe("set");
    if (res.kind !== "set") throw new Error("unreachable");
    expect(res.tpPrice).toBeCloseTo(0.932, 4);
  });

  it("falls back to the fixed 0.999 when the ROE target overshoots 1.0", () => {
    // The bot5 deep-ITM case: fill 0.989, lev 2, 5% ROE → target 1.014
    // (out of range). Instead of skipping, fall back to 0.999.
    const res = chooseTpDecision({
      fillPrice: 0.989,
      leverage: 2,
      roePct: 5,
      tickSize: 0.001,
    });
    expect(res.kind).toBe("set");
    if (res.kind !== "set") throw new Error("unreachable");
    expect(res.tpPrice).toBeCloseTo(DEFAULT_TP_PRICE, 4);
  });

  it("uses the fixed price directly when roePct is unset", () => {
    const res = chooseTpDecision({
      fillPrice: 0.92,
      leverage: 4,
      roePct: null,
      tickSize: 0.001,
    });
    expect(res.kind).toBe("set");
    if (res.kind !== "set") throw new Error("unreachable");
    expect(res.tpPrice).toBeCloseTo(DEFAULT_TP_PRICE, 4);
  });

  it("forceFixed skips the in-range ROE price and uses the fixed price", () => {
    // ROE would yield 0.932 (valid), but forceFixed (book bid past target)
    // routes to the higher 0.999 so it rests above the bid.
    const res = chooseTpDecision({
      fillPrice: 0.92,
      leverage: 4,
      roePct: 5,
      tickSize: 0.001,
      forceFixed: true,
    });
    expect(res.kind).toBe("set");
    if (res.kind !== "set") throw new Error("unreachable");
    expect(res.tpPrice).toBeCloseTo(DEFAULT_TP_PRICE, 4);
  });

  it("skips only when even the fixed fallback is out of range", () => {
    // fill already at the 0.999 cap → neither ROE nor fixed can rest above.
    const res = chooseTpDecision({
      fillPrice: 0.999,
      leverage: 2,
      roePct: 5,
      tickSize: 0.001,
    });
    expect(res.kind).toBe("skip");
  });

  it("forceFixed still skips when fill is at/above the fixed cap", () => {
    // forceFixed routes to the fixed price, which can't rest above a fill
    // already at the cap — must skip, not silently set an invalid TP.
    const res = chooseTpDecision({
      fillPrice: 0.999,
      leverage: 4,
      roePct: 5,
      tickSize: 0.001,
      forceFixed: true,
    });
    expect(res.kind).toBe("skip");
  });
});

describe("tpAnchorPrice", () => {
  it("uses the captured fill price when it's a real positive value", () => {
    expect(tpAnchorPrice(0.972, 0.97)).toBe(0.972);
  });

  it("falls back to limitPrice when fillPrice is 0 (the taker trap)", () => {
    // A plain `fillPrice ?? limitPrice` would return 0 here and skip the TP.
    expect(tpAnchorPrice(0, 0.97)).toBe(0.97);
  });

  it("falls back to limitPrice when fillPrice is null/undefined", () => {
    expect(tpAnchorPrice(null, 0.97)).toBe(0.97);
    expect(tpAnchorPrice(undefined, 0.97)).toBe(0.97);
  });

  it("falls back to limitPrice on negative or NaN fillPrice", () => {
    expect(tpAnchorPrice(-0.5, 0.97)).toBe(0.97);
    expect(tpAnchorPrice(NaN, 0.97)).toBe(0.97);
  });
});
