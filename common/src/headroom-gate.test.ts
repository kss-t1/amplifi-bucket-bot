import { describe, expect, it } from "bun:test";
import {
  evaluateHeadroom,
  headroomFraction,
  hourlyVol,
  type PositionSide,
} from "./headroom-gate.ts";
import type { PricePoint } from "./vol-gate.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const END = 100_000_000;

/** `n` points at 5-minute spacing ending at END, priced by `f(i)`. */
function buf(n: number, f: (i: number) => number): PricePoint[] {
  const out: PricePoint[] = [];
  for (let i = n - 1; i >= 0; i--)
    out.push({ ts: END - i * 5 * MIN, price: f(n - 1 - i) });
  return out;
}
const flat = buf(400, () => 100);
/** A deterministic pseudo-random walk. It must not be periodic in 12 candles:
 *  an alternating tape has identical prices one hour apart, so every hourly
 *  return is exactly zero and the fixture silently measures nothing. */
const choppy = buf(400, (i) => {
  let x = 100;
  for (let j = 0; j <= i; j++) {
    const r = Math.sin(j * 12.9898) * 43758.5453;
    x *= 1 + (r - Math.floor(r) - 0.5) * 0.004;
  }
  return x;
});

describe("headroomFraction", () => {
  it("measures the fall a YES position can absorb", () => {
    expect(headroomFraction(100, 90, "YES")).toBeCloseTo(0.1, 6);
  });
  it("measures the rise a NO position can absorb", () => {
    expect(headroomFraction(100, 110, "NO")).toBeCloseTo(0.1, 6);
  });
  it("goes negative once the position is the wrong side of the strike", () => {
    expect(headroomFraction(100, 110, "YES")).toBeCloseTo(-0.1, 6);
    expect(headroomFraction(100, 90, "NO")).toBeCloseTo(-0.1, 6);
  });
  it("rejects nonsense inputs", () => {
    expect(headroomFraction(0, 90, "YES")).toBeNull();
    expect(headroomFraction(100, 0, "YES")).toBeNull();
  });
});

describe("hourlyVol", () => {
  it("is zero on a flat tape", () => {
    expect(hourlyVol(flat)).toBeCloseTo(0, 9);
  });
  it("is positive on a moving tape", () => {
    expect(hourlyVol(choppy)!).toBeGreaterThan(0);
  });
  it("returns null before enough history accumulates", () => {
    expect(hourlyVol(buf(3, () => 100))).toBeNull();
    expect(hourlyVol([])).toBeNull();
  });
});

const CFG = { k: 7, timeExponent: 0 };

describe("evaluateHeadroom", () => {
  it("blocks a strike sitting inside the required cushion", () => {
    // the walk ends near 101.8; a NO strike at 102 is ~0.2% away, well inside
    // the 7 x 0.32% hourly vol this fixture measures
    const d = evaluateHeadroom(choppy, 102, "NO", 6, CFG);
    expect(d.block).toBe(true);
    expect(d.headroomPct!).toBeLessThan(d.requiredPct!);
  });

  it("allows a strike far outside the cushion", () => {
    const d = evaluateHeadroom(choppy, 200, "NO", 6, CFG);
    expect(d.block).toBe(false);
  });

  it("fails open when volatility cannot be measured", () => {
    const d = evaluateHeadroom(
      buf(3, () => 100),
      102,
      "NO",
      6,
      CFG,
    );
    expect(d.block).toBe(false);
    expect(d.requiredPct).toBeNull();
  });

  it("fails open on an empty buffer", () => {
    expect(evaluateHeadroom([], 100, "NO", 6, CFG).block).toBe(false);
  });

  it("blocks a position already the wrong side of the strike", () => {
    // spot is the last choppy price; a YES strike ABOVE it has negative headroom
    const spot = choppy[choppy.length - 1]!.price;
    expect(evaluateHeadroom(choppy, spot + 10, "YES", 6, CFG).block).toBe(true);
  });

  it("with timeExponent 0, hours-to-resolution does not change the verdict", () => {
    const near = evaluateHeadroom(choppy, 103, "NO", 1, CFG);
    const far = evaluateHeadroom(choppy, 103, "NO", 24, CFG);
    expect(near.requiredPct).toBeCloseTo(far.requiredPct!, 9);
    expect(near.block).toBe(far.block);
  });

  it("with timeExponent 0.5, a longer horizon demands more headroom", () => {
    const cfg = { k: 7, timeExponent: 0.5 };
    const near = evaluateHeadroom(choppy, 103, "NO", 1, cfg);
    const far = evaluateHeadroom(choppy, 103, "NO", 24, cfg);
    expect(far.requiredPct!).toBeGreaterThan(near.requiredPct!);
    expect(far.requiredPct!).toBeCloseTo(near.requiredPct! * Math.sqrt(24), 6);
  });

  it("a bigger k demands more headroom", () => {
    const lo = evaluateHeadroom(choppy, 103, "NO", 6, {
      k: 2,
      timeExponent: 0,
    });
    const hi = evaluateHeadroom(choppy, 103, "NO", 6, {
      k: 14,
      timeExponent: 0,
    });
    expect(hi.requiredPct!).toBeCloseTo(lo.requiredPct! * 7, 6);
  });

  it("reports the measurement even when it does not block", () => {
    const d = evaluateHeadroom(choppy, 200, "NO", 6, CFG);
    expect(d.block).toBe(false);
    expect(d.headroomPct!).toBeGreaterThan(0);
    expect(d.hourlyVolPct!).toBeGreaterThan(0);
    expect(d.hoursToResolution).toBe(6);
  });
});
