import { describe, expect, test } from "bun:test";
import { fillFromResponse, walkAsks } from "./executor.ts";

describe("walkAsks", () => {
  const asks = [
    { price: "0.96", size: "100" },
    { price: "0.95", size: "10" },
    { price: "0.951", size: "5" },
  ];

  test("takes only levels at or under the limit, cheapest first", () => {
    const f = walkAsks(asks, 0.95, 100)!;
    expect(f.shares).toBe(10);
    expect(f.cost).toBeCloseTo(9.5, 9);
  });

  test("stops at the dollar budget", () => {
    const f = walkAsks(asks, 0.951, 4.75)!;
    expect(f.shares).toBeCloseTo(5, 9);
    expect(f.cost).toBeCloseTo(4.75, 9);
  });

  test("returns null when the stale quote is gone", () => {
    expect(walkAsks(asks, 0.94, 100)).toBeNull();
  });
});

describe("fillFromResponse", () => {
  test("a matched buy reports collateral paid and shares received", () => {
    expect(
      fillFromResponse({ success: true, status: "matched", orderID: "0x1", makingAmount: "9.5", takingAmount: "10" }),
    ).toEqual({ shares: 10, cost: 9.5, orderId: "0x1" });
  });

  test("an unfilled or rejected order is no fill", () => {
    expect(fillFromResponse({ success: true, status: "unmatched", makingAmount: "0", takingAmount: "0" })).toBeNull();
    expect(fillFromResponse({ error: "no orders found to match with FAK order" })).toBeNull();
    expect(fillFromResponse({ success: false, makingAmount: "9.5", takingAmount: "10" })).toBeNull();
  });
});
