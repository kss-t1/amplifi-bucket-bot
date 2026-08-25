import { describe, expect, it } from "bun:test";
import {
  evaluateHeadroom,
  headroomFraction,
  hourlyVol,
  measure,
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
  it("ignores lookbacks that land far off one hour, so a gap cannot fake calm", () => {
    // One old anchor, a 6h hole, then 13 samples inside the following hour and
    // 30% higher. Every one of them looks back past the hole to that same
    // anchor, so unbounded their returns are near-identical: stdev collapses
    // and a 30% jump reads as dead calm. Bounded, none of them qualify at all.
    // 12 samples on the 5-minute grid, all inside the hour after the hole, so
    // every one of them reaches back past it to the anchor.
    const gapped: PricePoint[] = [{ ts: END, price: 100 }];
    for (let i = 0; i < 12; i++)
      gapped.push({
        ts: END + 6 * HOUR + i * 5 * MIN,
        price: 130 * (1 + i * 0.0001),
      });

    // coverage relaxed too, so this isolates the lookback bound alone
    const unbounded = hourlyVol(
      gapped,
      24 * HOUR,
      12,
      Number.MAX_SAFE_INTEGER,
      0,
    );
    expect(unbounded).not.toBeNull();
    expect(unbounded!).toBeLessThan(1e-3); // a 30% move measured as ~zero vol

    expect(hourlyVol(gapped)).toBeNull(); // bounded: refuses to measure
  });

  it("a calm 20s-polled stretch cannot drown out a violent 5m-seeded one", () => {
    // The real buffer is 5-minute seed candles followed by 20-second polls. A
    // few flat live hours contribute 15x the points per hour, so unresampled
    // they outvote a genuinely violent seeded day and the gate stops asking for
    // a cushion right after things go quiet.
    const pts: PricePoint[] = [];
    const start = END - 24 * HOUR;
    for (let t = start; t < END - 4 * HOUR; t += 5 * MIN) {
      const r = Math.sin(t * 12.9898) * 43758.5453;
      pts.push({ ts: t, price: 100 * (1 + (r - Math.floor(r) - 0.5) * 0.06) });
    }
    for (let t = END - 4 * HOUR; t <= END; t += 20_000)
      pts.push({ ts: t, price: 100 });

    // Measured: 0.0219 resampled, 0.0143 without — a 35% understatement.
    expect(hourlyVol(pts)!).toBeGreaterThan(0.018);
  });

  it("refuses to call one fresh hour a day, after a long blackout", () => {
    // The bot stayed up through a 30h outage, so no reseed happened; an hour of
    // post-outage polls is enough samples but nowhere near enough of the window.
    const pts: PricePoint[] = [];
    for (let i = 0; i < 12; i++)
      pts.push({ ts: END - 30 * HOUR + i * 5 * MIN, price: 100 });
    // just over two hours back, so the later points have valid in-hour lookbacks
    for (let i = 0; i < 26; i++)
      pts.push({ ts: END - 2 * HOUR + i * 5 * MIN, price: 100 + i * 0.01 });
    expect(hourlyVol(pts)).toBeNull();
    // the same samples pass once the coverage requirement is lifted
    expect(hourlyVol(pts, 24 * HOUR, 12, 10 * MIN, 0)).not.toBeNull();
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
    const d = evaluateHeadroom(measure(choppy), 102, "NO", 6, CFG);
    expect(d.block).toBe(true);
    expect(d.headroomPct!).toBeLessThan(d.requiredPct!);
  });

  it("allows a strike far outside the cushion", () => {
    const d = evaluateHeadroom(measure(choppy), 200, "NO", 6, CFG);
    expect(d.block).toBe(false);
  });

  it("fails open when volatility cannot be measured", () => {
    const d = evaluateHeadroom(measure(buf(3, () => 100)), 102, "NO", 6, CFG);
    expect(d.block).toBe(false);
    expect(d.requiredPct).toBeNull();
  });

  it("fails open on an empty buffer", () => {
    expect(evaluateHeadroom(measure([]), 100, "NO", 6, CFG).block).toBe(false);
  });

  it("blocks a position already the wrong side of the strike", () => {
    // spot is the last choppy price; a YES strike ABOVE it has negative headroom
    const spot = choppy[choppy.length - 1]!.price;
    expect(
      evaluateHeadroom(measure(choppy), spot + 10, "YES", 6, CFG).block,
    ).toBe(true);
  });

  it("with timeExponent 0, hours-to-resolution does not change the verdict", () => {
    const near = evaluateHeadroom(measure(choppy), 103, "NO", 1, CFG);
    const far = evaluateHeadroom(measure(choppy), 103, "NO", 24, CFG);
    expect(near.requiredPct).toBeCloseTo(far.requiredPct!, 9);
    expect(near.block).toBe(far.block);
  });

  it("with timeExponent 0.5, a longer horizon demands more headroom", () => {
    const cfg = { k: 7, timeExponent: 0.5 };
    const near = evaluateHeadroom(measure(choppy), 103, "NO", 1, cfg);
    const far = evaluateHeadroom(measure(choppy), 103, "NO", 24, cfg);
    expect(far.requiredPct!).toBeGreaterThan(near.requiredPct!);
    expect(far.requiredPct!).toBeCloseTo(near.requiredPct! * Math.sqrt(24), 6);
  });

  it("a bigger k demands more headroom", () => {
    const lo = evaluateHeadroom(measure(choppy), 103, "NO", 6, {
      k: 2,
      timeExponent: 0,
    });
    const hi = evaluateHeadroom(measure(choppy), 103, "NO", 6, {
      k: 14,
      timeExponent: 0,
    });
    expect(hi.requiredPct!).toBeCloseTo(lo.requiredPct! * 7, 6);
  });

  it("still evaluates with an unknown horizon while timeExponent is 0", () => {
    const d = evaluateHeadroom(measure(choppy), 102, "NO", null, CFG);
    expect(d.block).toBe(true);
    expect(d.hoursToResolution).toBeNull();
  });

  it("fails open on an unknown horizon once the requirement scales with it", () => {
    const d = evaluateHeadroom(measure(choppy), 102, "NO", null, {
      k: 7,
      timeExponent: 0.5,
    });
    expect(d.block).toBe(false);
    expect(d.requiredPct).toBeNull();
  });

  it("reports the measurement even when it does not block", () => {
    const d = evaluateHeadroom(measure(choppy), 200, "NO", 6, CFG);
    expect(d.block).toBe(false);
    expect(d.headroomPct!).toBeGreaterThan(0);
    expect(d.hourlyVolPct!).toBeGreaterThan(0);
    expect(d.hoursToResolution).toBe(6);
  });
});
