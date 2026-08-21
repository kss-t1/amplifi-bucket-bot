import { describe, expect, it } from "bun:test";
import {
  absMove,
  DEFAULT_VOL_RULES,
  evaluateRules,
  moveHurts,
  parseVolRules,
  priceAtOrBefore,
  signedMove,
  type PricePoint,
  type VolRule,
} from "./vol-gate.ts";

const MIN = 60_000;
// ascending buffer: `prices` spaced 5 min apart, ending at `endTs`.
function buf(endTs: number, prices: number[]): PricePoint[] {
  const n = prices.length;
  return prices.map((price, i) => ({
    ts: endTs - (n - 1 - i) * 5 * MIN,
    price,
  }));
}
const RULES: VolRule[] = [
  { label: "15m", windowMs: 15 * MIN, thresholdPct: 0.8 },
  { label: "4h", windowMs: 4 * 60 * MIN, thresholdPct: 2.0 },
];

describe("parseVolRules", () => {
  it("returns defaults on empty/undefined", () => {
    expect(parseVolRules(undefined)).toEqual(DEFAULT_VOL_RULES);
    expect(parseVolRules("  ")).toEqual(DEFAULT_VOL_RULES);
  });
  it("parses a multi-rule spec with mixed units", () => {
    const r = parseVolRules("15m:0.8, 4h:2.0 , 1d:5");
    expect(r).toHaveLength(3);
    expect(r[0]).toEqual({
      label: "15m",
      windowMs: 15 * MIN,
      thresholdPct: 0.8,
    });
    expect(r[1]!.windowMs).toBe(4 * 60 * MIN);
    expect(r[2]!.windowMs).toBe(24 * 60 * MIN);
    expect(r[2]!.thresholdPct).toBe(5);
  });
  it("supports seconds and arbitrary windows (full flexibility)", () => {
    const r = parseVolRules("30s:0.1,90m:1.5");
    expect(r[0]!.windowMs).toBe(30_000);
    expect(r[1]!.windowMs).toBe(90 * MIN);
  });
  it("throws on a malformed token", () => {
    expect(() => parseVolRules("15m=0.8")).toThrow();
    expect(() => parseVolRules("15x:0.8")).toThrow();
    expect(() => parseVolRules("15m:0")).toThrow(); // threshold must be > 0
    expect(() => parseVolRules("15m:150")).toThrow(); // > 100
  });
});

describe("absMove / priceAtOrBefore", () => {
  it("priceAtOrBefore returns latest at/before ts", () => {
    const b = [
      { ts: 100, price: 10 },
      { ts: 200, price: 20 },
    ];
    expect(priceAtOrBefore(b, 150)).toBe(10);
    expect(priceAtOrBefore(b, 50)).toBeNull();
  });
  it("null during warm-up", () => {
    expect(absMove(buf(5 * 60 * MIN, [100, 101, 102]), 15 * MIN)).toBeNull();
    expect(absMove([], 15 * MIN)).toBeNull();
  });
  it("computes absolute move, direction-agnostic", () => {
    const end = 10 * 60 * MIN;
    const down = new Array(60).fill(100);
    down[down.length - 1] = 95;
    expect(absMove(buf(end, down), 4 * 60 * MIN)!).toBeCloseTo(0.05, 3);
    const up = new Array(60).fill(100);
    up[up.length - 1] = 102;
    expect(absMove(buf(end, up), 4 * 60 * MIN)!).toBeCloseTo(0.02, 3);
  });
});

describe("evaluateRules", () => {
  const end = 10 * 60 * MIN;
  it("does not block when calm", () => {
    const d = evaluateRules(buf(end, new Array(60).fill(100)), RULES);
    expect(d.block).toBe(false);
    expect(d.breaches).toHaveLength(0);
  });
  it("blocks via the short arm on a sharp spike", () => {
    const p = new Array(60).fill(100);
    p[p.length - 1] = 98.5; // -1.5% in last 15m
    const d = evaluateRules(buf(end, p), RULES);
    expect(d.block).toBe(true);
    expect(d.breaches.map((b) => b.label)).toContain("15m");
  });
  it("blocks via the long arm on a slow grind the short arm misses", () => {
    const p: number[] = [];
    for (let i = 0; i < 60; i++) p.push(100 - i * 0.06); // smooth ~3.5% over 5h
    const d = evaluateRules(buf(end, p), RULES);
    expect(d.moves["15m"]!).toBeLessThan(0.8);
    expect(d.moves["4h"]!).toBeGreaterThan(2.0);
    expect(d.block).toBe(true);
    expect(d.breaches.map((b) => b.label)).toEqual(["4h"]);
  });
  it("supports an arbitrary single custom rule", () => {
    const p = new Array(60).fill(100);
    p[p.length - 1] = 99; // -1% in 15m
    const oneRule: VolRule[] = [
      { label: "15m", windowMs: 15 * MIN, thresholdPct: 0.5 },
    ];
    expect(evaluateRules(buf(end, p), oneRule).block).toBe(true);
  });
});

describe("directional rules", () => {
  const DIR: VolRule[] = [
    {
      label: "4h:dir",
      windowMs: 4 * 60 * MIN,
      thresholdPct: 2.0,
      directional: true,
    },
  ];
  const END = 10_000_000;
  // 49 points at 5-min spacing spans 4h, so the 4h window is warm.
  const flat = Array.from({ length: 49 }, () => 100);
  const rise = [...flat.slice(0, 48), 110]; // +10% at the end
  const fall = [...flat.slice(0, 48), 90]; // -10% at the end

  it("parses the :dir suffix and labels it", () => {
    const r = parseVolRules("48h:5:dir,15m:1.0");
    expect(r[0]).toEqual({
      label: "48h:dir",
      windowMs: 48 * 60 * MIN,
      thresholdPct: 5,
      directional: true,
    });
    expect(r[1]!.directional).toBeUndefined();
    expect(r[1]!.label).toBe("15m");
  });

  it("signedMove keeps the sign; absMove does not", () => {
    expect(signedMove(buf(END, rise), 4 * 60 * MIN)).toBeCloseTo(0.1, 6);
    expect(signedMove(buf(END, fall), 4 * 60 * MIN)).toBeCloseTo(-0.1, 6);
    expect(absMove(buf(END, fall), 4 * 60 * MIN)).toBeCloseTo(0.1, 6);
  });

  it("moveHurts: a rise hurts NO, a fall hurts YES", () => {
    expect(moveHurts(0.05, "NO")).toBe(true);
    expect(moveHurts(0.05, "YES")).toBe(false);
    expect(moveHurts(-0.05, "YES")).toBe(true);
    expect(moveHurts(-0.05, "NO")).toBe(false);
  });

  it("a rise blocks NO and lets YES through", () => {
    const b = buf(END, rise);
    expect(evaluateRules(b, DIR, "NO").block).toBe(true);
    expect(evaluateRules(b, DIR, "YES").block).toBe(false);
  });

  it("a fall blocks YES and lets NO through", () => {
    const b = buf(END, fall);
    expect(evaluateRules(b, DIR, "YES").block).toBe(true);
    expect(evaluateRules(b, DIR, "NO").block).toBe(false);
  });

  it("with no side, a directional rule falls back to absolute", () => {
    expect(evaluateRules(buf(END, rise), DIR).block).toBe(true);
    expect(evaluateRules(buf(END, fall), DIR).block).toBe(true);
  });

  it("an absolute rule ignores the side entirely", () => {
    const abs: VolRule[] = [
      { label: "4h", windowMs: 4 * 60 * MIN, thresholdPct: 2.0 },
    ];
    expect(evaluateRules(buf(END, rise), abs, "YES").block).toBe(true);
    expect(evaluateRules(buf(END, rise), abs, "NO").block).toBe(true);
  });

  it("a calm buffer blocks neither side", () => {
    const b = buf(END, flat);
    expect(evaluateRules(b, DIR, "NO").block).toBe(false);
    expect(evaluateRules(b, DIR, "YES").block).toBe(false);
  });

  it("reports the move magnitude even when the side is spared", () => {
    const d = evaluateRules(buf(END, rise), DIR, "YES");
    expect(d.block).toBe(false);
    expect(d.moves["4h:dir"]).toBeCloseTo(10, 4);
  });
});
