import { describe, expect, test } from "bun:test";
import { positionPnl, resolvedYesPayout, type Position } from "./settlement.ts";

describe("resolvedYesPayout", () => {
  test("reads a 1/0 outcome only once the market is closed", () => {
    expect(resolvedYesPayout({ closed: true, outcomePrices: '["1", "0"]' })).toBe(1);
    expect(resolvedYesPayout({ closed: true, outcomePrices: '["0", "1"]' })).toBe(0);
    expect(resolvedYesPayout({ closed: false, outcomePrices: '["1", "0"]' })).toBeNull();
    expect(resolvedYesPayout({ closed: true, outcomePrices: '["0.9995", "0.0005"]' })).toBeNull();
  });
});

describe("positionPnl", () => {
  const p: Position = {
    slug: "s",
    conditionId: "0x1",
    tokenId: "1",
    side: "NO",
    strikeUsd: 80000,
    endMs: 0,
    shares: 10,
    cost: 9.5,
    fee: 0.03,
    openedAtMs: 0,
    fair: 0.97,
    edge: 0.02,
  };

  test("is null until settled, then payout minus cost and fee", () => {
    expect(positionPnl(p)).toBeNull();
    expect(positionPnl({ ...p, payout: 1 })).toBeCloseTo(0.47, 9);
    expect(positionPnl({ ...p, payout: 0 })).toBeCloseTo(-9.53, 9);
  });
});
