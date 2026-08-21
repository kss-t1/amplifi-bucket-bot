import { describe, expect, it } from "bun:test";
import {
  absMove,
  DEFAULT_VOL_RULES,
  evaluateRules,
  parseVolRules,
  priceAtOrBefore,
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
