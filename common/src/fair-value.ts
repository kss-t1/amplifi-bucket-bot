/**
 * Fair value of a BTC daily-above strike: the probability that the Binance
 * BTC/USDT 1-minute close at resolution ends above the strike, priced as a
 * cash-or-nothing digital option on a driftless lognormal.
 *
 * Volatility is not flat through the day. `hourlyVol` is the trailing realized
 * stdev of hourly log returns (see `hourlyVol` in headroom-gate.ts), which is
 * an average over all hours of the day. A 24-entry profile rescales it per UTC
 * hour, so a horizon covering the US session carries more variance than the
 * same length of night. Profiles are normalized to mean 1.
 *
 * BTC moves have fatter tails than a normal distribution: a plain lognormal
 * says 3% where the outcome happens 8% of the time. `tails` mixes in a second,
 * wider regime while keeping the total variance unchanged.
 */

const HOUR = 3_600_000;

/** Relative variance per UTC hour, index 0 = 00:00–01:00 UTC. Mean 1. */
export type VolProfile = readonly number[];

export const FLAT_PROFILE: VolProfile = Object.freeze(Array(24).fill(1));

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 erf, abs error < 1.5e-7). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t *
    (0.254829592 +
      t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Scale a profile so its mean is 1. Throws on a profile that is not 24
 *  positive finite numbers, so a bad file fails at startup. */
export function normalizeProfile(raw: readonly number[]): VolProfile {
  if (raw.length !== 24 || raw.some((v) => !(Number.isFinite(v) && v > 0)))
    throw new Error("vol profile must be 24 positive numbers");
  const mean = raw.reduce((a, b) => a + b, 0) / 24;
  return Object.freeze(raw.map((v) => v / mean));
}

/** Expected variance of the log price between `nowMs` and `endMs`. */
export function horizonVariance(
  nowMs: number,
  endMs: number,
  hourlyVol: number,
  profile: VolProfile = FLAT_PROFILE,
): number {
  if (!(endMs > nowMs) || !(hourlyVol > 0)) return 0;
  const perHour = hourlyVol * hourlyVol;
  let v = 0;
  let t = nowMs;
  while (t < endMs) {
    const next = Math.min(endMs, (Math.floor(t / HOUR) + 1) * HOUR);
    const utcHour = new Date(t).getUTCHours();
    v += perHour * profile[utcHour]! * ((next - t) / HOUR);
    t = next;
  }
  return v;
}

/** A share `weight` of outcomes comes from a regime whose stdev is `ratio`
 *  times the calm one; the total variance stays what the caller passed. */
export interface TailMix {
  weight: number;
  ratio: number;
}

function lognormalAbove(x: number, v: number): number {
  return normCdf((x - v / 2) / Math.sqrt(v));
}

/** P(S_T > K) for a driftless lognormal with total log variance `variance`. */
export function probAbove(
  spot: number,
  strike: number,
  variance: number,
  tails?: TailMix,
): number {
  if (!(variance > 0)) return spot > strike ? 1 : 0;
  const x = Math.log(spot / strike);
  if (!tails || !(tails.weight > 0)) return lognormalAbove(x, variance);
  const { weight: w, ratio: k } = tails;
  const calm = variance / (1 - w + w * k * k);
  return (1 - w) * lognormalAbove(x, calm) + w * lognormalAbove(x, calm * k * k);
}

export interface FairValueInput {
  spot: number;
  strikeUsd: number;
  nowMs: number;
  endMs: number;
  /** Trailing realized stdev of hourly log returns, as a fraction. */
  hourlyVol: number;
  profile?: VolProfile;
  tails?: TailMix;
}

export interface FairValue {
  yes: number;
  no: number;
  /** Stdev of the log price over the remaining horizon. */
  horizonSd: number;
  /** Spot-to-strike distance in horizon stdevs (positive = above). */
  zScore: number;
}

/** null when an input is missing or nonsensical; callers should not trade. */
export function fairValue(i: FairValueInput): FairValue | null {
  if (!(i.spot > 0) || !(i.strikeUsd > 0) || !(i.hourlyVol >= 0)) return null;
  if (!Number.isFinite(i.nowMs) || !Number.isFinite(i.endMs)) return null;
  const variance = horizonVariance(i.nowMs, i.endMs, i.hourlyVol, i.profile);
  const yes = probAbove(i.spot, i.strikeUsd, variance, i.tails);
  const sd = Math.sqrt(variance);
  const dist = Math.log(i.spot / i.strikeUsd);
  return {
    yes,
    no: 1 - yes,
    horizonSd: sd,
    zScore: sd > 0 ? dist / sd : dist > 0 ? Infinity : dist < 0 ? -Infinity : 0,
  };
}

/**
 * Hour-of-day variance profile from 1-minute closes: mean squared 1-minute log
 * return in each UTC hour, normalized to mean 1. Gaps longer than `maxGapMs`
 * are skipped so a missing stretch is not counted as one huge minute.
 */
export function profileFromCloses(
  closes: readonly { ts: number; price: number }[],
  maxGapMs = 2 * 60_000,
): VolProfile {
  const sum = Array(24).fill(0);
  const n = Array(24).fill(0);
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1]!;
    const b = closes[i]!;
    if (!(a.price > 0 && b.price > 0) || b.ts - a.ts > maxGapMs || b.ts <= a.ts)
      continue;
    const r = Math.log(b.price / a.price);
    const h = new Date(b.ts).getUTCHours();
    sum[h] += r * r;
    n[h]++;
  }
  if (n.some((c) => c === 0)) throw new Error("profile needs data in every UTC hour");
  return normalizeProfile(sum.map((s, h) => s / n[h]));
}
