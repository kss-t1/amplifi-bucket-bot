import { describe, expect, it } from "bun:test";
import {
  FLAT_PROFILE,
  fairValue,
  horizonVariance,
  normCdf,
  normalizeProfile,
  probAbove,
  profileFromCloses,
} from "./fair-value.ts";

const HOUR = 3_600_000;
const NOON_UTC = Date.UTC(2026, 9, 24, 12);

describe("normCdf", () => {
  it("matches reference values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1)).toBeCloseTo(0.841345, 5);
    expect(normCdf(-1.96)).toBeCloseTo(0.024998, 5);
    expect(normCdf(3)).toBeCloseTo(0.99865, 5);
  });
});

describe("horizonVariance", () => {
  it("is hourlyVol² × hours on a flat profile", () => {
    expect(horizonVariance(NOON_UTC, NOON_UTC + 4 * HOUR, 0.01)).toBeCloseTo(4e-4, 12);
  });
  it("splits partial hours at the hour boundary", () => {
    const profile = normalizeProfile(Array.from({ length: 24 }, (_, h) => (h === 12 ? 3 : 1)));
    const v = horizonVariance(NOON_UTC + 0.5 * HOUR, NOON_UTC + 1.5 * HOUR, 0.01, profile);
    expect(v).toBeCloseTo(1e-4 * (0.5 * profile[12]! + 0.5 * profile[13]!), 12);
  });
  it("is zero once the horizon has passed", () => {
    expect(horizonVariance(NOON_UTC, NOON_UTC - HOUR, 0.01)).toBe(0);
  });
});

describe("probAbove", () => {
  it("is just under one half at the money, from the lognormal drift correction", () => {
    const p = probAbove(100, 100, 1e-4);
    expect(p).toBeLessThan(0.5);
    expect(p).toBeGreaterThan(0.49);
  });
  it("collapses to the settled outcome with no variance left", () => {
    expect(probAbove(101, 100, 0)).toBe(1);
    expect(probAbove(99, 100, 0)).toBe(0);
    expect(probAbove(100, 100, 0)).toBe(0);
  });
  it("reproduces the worked example: 0.7 horizon stdevs above is about 0.76", () => {
    const sd = 0.01;
    const spot = 100 * Math.exp(0.7 * sd);
    expect(probAbove(spot, 100, sd * sd)).toBeCloseTo(0.756, 2);
  });
});

describe("probAbove with tails", () => {
  it("puts more probability on a far strike than the plain lognormal", () => {
    const v = 1e-4;
    const threeSdBelow = 100 * Math.exp(-3 * 0.01);
    expect(probAbove(threeSdBelow, 100, v, { weight: 0.3, ratio: 3 })).toBeGreaterThan(
      probAbove(threeSdBelow, 100, v),
    );
  });
  it("is the plain lognormal with zero weight", () => {
    expect(probAbove(101, 100, 1e-4, { weight: 0, ratio: 3 })).toBe(probAbove(101, 100, 1e-4));
  });
});

describe("fairValue", () => {
  it("prices YES and NO to sum to one", () => {
    const fv = fairValue({ spot: 110_800, strikeUsd: 110_000, nowMs: NOON_UTC, endMs: NOON_UTC + 4 * HOUR, hourlyVol: 0.005 })!;
    expect(fv.yes + fv.no).toBeCloseTo(1, 12);
    expect(fv.yes).toBeGreaterThan(0.5);
    expect(fv.zScore).toBeCloseTo(Math.log(110_800 / 110_000) / 0.01, 9);
  });
  it("gets more confident as time runs out at the same distance", () => {
    const at = (h: number) => fairValue({ spot: 101, strikeUsd: 100, nowMs: NOON_UTC, endMs: NOON_UTC + h * HOUR, hourlyVol: 0.005 })!.yes;
    expect(at(1)).toBeGreaterThan(at(6));
    expect(at(6)).toBeGreaterThan(at(24));
  });
  it("treats a busier upcoming session as more uncertainty", () => {
    const busy = normalizeProfile(Array.from({ length: 24 }, (_, h) => (h >= 12 && h < 16 ? 4 : 1)));
    const base = { spot: 101, strikeUsd: 100, nowMs: NOON_UTC, endMs: NOON_UTC + 4 * HOUR, hourlyVol: 0.005 };
    expect(fairValue({ ...base, profile: busy })!.yes).toBeLessThan(fairValue({ ...base, profile: FLAT_PROFILE })!.yes);
  });
  it("refuses nonsense inputs", () => {
    const ok = { spot: 100, strikeUsd: 100, nowMs: NOON_UTC, endMs: NOON_UTC + HOUR, hourlyVol: 0.01 };
    expect(fairValue({ ...ok, spot: 0 })).toBeNull();
    expect(fairValue({ ...ok, strikeUsd: NaN })).toBeNull();
    expect(fairValue({ ...ok, hourlyVol: -1 })).toBeNull();
  });
});

describe("normalizeProfile", () => {
  it("scales to mean one", () => {
    const p = normalizeProfile(Array(24).fill(5));
    expect(p.every((v) => Math.abs(v - 1) < 1e-12)).toBe(true);
  });
  it("rejects the wrong length or a non-positive entry", () => {
    expect(() => normalizeProfile([1, 2, 3])).toThrow();
    expect(() => normalizeProfile([...Array(23).fill(1), 0])).toThrow();
  });
});

describe("profileFromCloses", () => {
  const day = Date.UTC(2026, 9, 1);
  /** One day of 1-minute closes whose moves are three times larger in hour 14. */
  function tape(): { ts: number; price: number }[] {
    const out = [{ ts: day, price: 100 }];
    for (let m = 1; m < 24 * 60; m++) {
      const ts = day + m * 60_000;
      const step = new Date(ts).getUTCHours() === 14 ? 0.003 : 0.001;
      out.push({ ts, price: out[m - 1]!.price * Math.exp(m % 2 ? step : -step) });
    }
    return out;
  }
  it("puts more variance on the hour that moves more", () => {
    const p = profileFromCloses(tape());
    expect(p[14]! / p[3]!).toBeCloseTo(9, 6);
    expect(p.reduce((a, b) => a + b, 0) / 24).toBeCloseTo(1, 12);
  });
  it("skips a gap instead of counting it as one large minute", () => {
    const t = tape();
    t.splice(300, 30);
    for (let i = 300; i < t.length; i++) t[i] = { ...t[i]!, price: t[i]!.price * 1.5 };
    const p = profileFromCloses(t);
    expect(p[5]! / p[3]!).toBeLessThan(2);
  });
});

describe("BTC_FAIR_VALUE_PARAMS", () => {
  it("loads a usable fitted parameter set", async () => {
    const { BTC_FAIR_VALUE_PARAMS: p } = await import("./btc-fair-value-params.ts");
    expect(p.profile).toHaveLength(24);
    expect(p.profile.reduce((a, b) => a + b, 0) / 24).toBeCloseTo(1, 9);
    expect(p.volScale).toBeGreaterThan(0);
    expect(p.tails.weight).toBeGreaterThanOrEqual(0);
  });
});
