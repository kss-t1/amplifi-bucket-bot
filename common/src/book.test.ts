import { describe, expect, it } from "bun:test";
import { ceilToTick, floorToTick } from "./book.ts";

describe("floorToTick / ceilToTick", () => {
  it("returns a price in (0,1) for typical CLOB inputs", () => {
    // Regression: previous formula did `* (1/tick) / (1/tick)` which is
    // a no-op, leaving Math.floor(price/tick) unmultiplied — so
    // floorToTick(0.36, 0.01) returned 36 instead of 0.36. Caught live
    // on vm018 dry-run when the bot logged `yesBuyPrice: 36`.
    expect(floorToTick(0.36, 0.01)).toBe(0.36);
    expect(floorToTick(0.375, 0.01)).toBe(0.37);
    expect(floorToTick(0.999, 0.01)).toBe(0.99);
    expect(ceilToTick(0.36, 0.01)).toBe(0.36);
    expect(ceilToTick(0.375, 0.01)).toBe(0.38);
    expect(ceilToTick(0.001, 0.01)).toBe(0.01);
  });

  it("handles sub-cent tick sizes", () => {
    expect(floorToTick(0.5234, 0.001)).toBe(0.523);
    expect(ceilToTick(0.5234, 0.001)).toBe(0.524);
  });

  it("strips IEEE-754 float noise", () => {
    // 0.1 + 0.2 = 0.30000000000000004 is the canonical example.
    // Math.floor((0.1 + 0.2) / 0.01) * 0.01 yields 0.30000000000000004
    // pre-toFixed; the formatter must clamp it to 0.3.
    expect(floorToTick(0.1 + 0.2, 0.01)).toBe(0.3);
    expect(ceilToTick(0.1 + 0.2, 0.01)).toBe(0.3);
  });

  it("on a price already on-tick is a no-op", () => {
    expect(floorToTick(0.42, 0.01)).toBe(0.42);
    expect(ceilToTick(0.42, 0.01)).toBe(0.42);
  });
});
