/**
 * Headroom gate: refuse an open when BTC sits too close to the strike for the
 * current level of volatility.
 *
 * A daily-above position wins by BTC STAYING on its side of the strike, so the
 * distance from spot to the strike is the cushion. What counts as enough
 * cushion depends on how much BTC is moving, so the requirement is expressed in
 * units of realized hourly volatility:
 *
 *   headroom = favourable distance to the strike, as a fraction of spot
 *   required = k * hourlyVol * hours^timeExponent
 *   block when headroom < required
 *
 * `timeExponent` defaults to 0, i.e. time-to-resolution does NOT raise the bar.
 * That is measured, not assumed: on 11,556 fleet positions the liquidation rate
 * FALLS as time-to-resolution grows (7.0% at 0-3h vs 3.5% at 18-25h), because
 * the market already prices in a wider cushion further out (median headroom
 * 2.54% at 0-3h vs 4.95% at 18-25h). Scaling the requirement with sqrt(hours)
 * therefore blocks the profitable long-dated opens and admits the risky
 * short-dated ones. The knob exists so the choice stays testable.
 *
 * Fails OPEN: a null vol reading never blocks, matching the vol gate.
 */
import type { PricePoint } from "./vol-gate.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Sampling grid for the vol estimate; also what the threshold was tuned on. */
const GRID_MS = 5 * MIN;

export type PositionSide = "YES" | "NO";

/** Realized stdev of hourly log returns over the trailing `windowMs`.
 *  null when the buffer does not hold enough history. */
export function hourlyVol(
  buffer: PricePoint[],
  windowMs = 24 * HOUR,
  minSamples = 12,
  /** How far off a one-hour lookback may land. A poll outage leaves a gap, and
   *  an unbounded lookback would then measure several samples against the SAME
   *  pre-gap price: those returns are near-identical, so their stdev collapses
   *  toward zero and the gate stops requiring any cushion at exactly the moment
   *  a large move went unobserved. */
  maxLookbackSkewMs = 10 * MIN,
  /** Fraction of `windowMs` the accepted returns must actually span. A mid-run
   *  feed outage leaves a hole the lookback bound already refuses to measure
   *  across, so once an hour of fresh data accumulates there are 12 samples
   *  again — all from that one hour. Without this, a calm hour after a long
   *  blackout would be reported as a calm day. A fresh `seed()` covers the
   *  whole window from klines, so this never bites at startup. */
  minCoverage = 0.5,
): number | null {
  if (buffer.length < 2) return null;
  // Resample to one point per 5 minutes first. The buffer mixes 5-minute seed
  // candles with 20-second live polls, so counting every point would weight an
  // hour of live data 15x an hour of seeded data and make the reading depend on
  // how long the bot has been up. The grid also matches the sampling the
  // threshold was calibrated on.
  const grid: PricePoint[] = [];
  for (const p of buffer) {
    if (!(p.price > 0)) continue;
    const bucket = Math.floor(p.ts / GRID_MS);
    const tail = grid[grid.length - 1];
    if (tail !== undefined && Math.floor(tail.ts / GRID_MS) === bucket)
      grid[grid.length - 1] = p;
    else grid.push(p);
  }
  if (grid.length < 2) return null;
  const last = grid[grid.length - 1]!;
  const from = last.ts - windowMs;
  const rets: number[] = [];
  let spanStart = 0;
  let spanEnd = 0;
  // `want` only increases, so the lookback index never rewinds: one pass, not a
  // rescan per point.
  let j = 0;
  for (const p of grid) {
    if (p.ts < from) continue;
    const want = p.ts - HOUR;
    while (j + 1 < grid.length && grid[j + 1]!.ts <= want) j++;
    const prior = grid[j]!;
    if (prior.ts > want || prior.price <= 0) continue;
    if (want - prior.ts > maxLookbackSkewMs) continue;
    if (rets.length === 0) spanStart = p.ts;
    spanEnd = p.ts;
    rets.push(Math.log(p.price / prior.price));
  }
  if (rets.length < minSamples) return null;
  if (spanEnd - spanStart < windowMs * minCoverage) return null;
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr =
    rets.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (rets.length - 1);
  return Math.sqrt(varr);
}

/**
 * Favourable distance from spot to the strike, as a fraction of spot.
 * A YES position wants BTC to stay ABOVE the strike, so its cushion is how far
 * BTC can fall; a NO position wants BTC below, so its cushion is the rise.
 * Negative when the position is already the wrong side of the strike.
 */
export function headroomFraction(
  spot: number,
  strikeUsd: number,
  side: PositionSide,
): number | null {
  if (!(spot > 0) || !(strikeUsd > 0)) return null;
  return side === "YES" ? (spot - strikeUsd) / spot : (strikeUsd - spot) / spot;
}

export interface HeadroomConfig {
  k: number;
  /** 0 = requirement independent of time to resolution (the measured default). */
  timeExponent: number;
}

export interface HeadroomDecision {
  block: boolean;
  headroomPct: number | null;
  requiredPct: number | null;
  hourlyVolPct: number | null;
  /** null when the caller could not determine it, which is only usable while
   *  `timeExponent` is 0 and the requirement does not depend on it. */
  hoursToResolution: number | null;
}

/** Spot and realized vol, measured once per cycle and reused across targets. */
export interface VolMeasurement {
  spot: number | null;
  hourlyVol: number | null;
}

export function measure(buffer: PricePoint[]): VolMeasurement {
  return {
    spot: buffer.length > 0 ? buffer[buffer.length - 1]!.price : null,
    hourlyVol: hourlyVol(buffer),
  };
}

export function evaluateHeadroom(
  m: VolMeasurement,
  strikeUsd: number,
  side: PositionSide,
  hoursToResolution: number | null,
  cfg: HeadroomConfig,
): HeadroomDecision {
  const { spot, hourlyVol: vol } = m;
  const head = spot === null ? null : headroomFraction(spot, strikeUsd, side);
  const base = {
    headroomPct: head === null ? null : head * 100,
    hourlyVolPct: vol === null ? null : vol * 100,
    hoursToResolution,
  };
  if (vol === null || head === null)
    return { block: false, requiredPct: null, ...base };
  // Unknown horizon only matters when the requirement scales with it.
  if (hoursToResolution === null && cfg.timeExponent !== 0)
    return { block: false, requiredPct: null, ...base };
  const hours = Math.max(0, hoursToResolution ?? 0);
  const required =
    cfg.k * vol * (cfg.timeExponent === 0 ? 1 : hours ** cfg.timeExponent);
  return { block: head < required, requiredPct: required * 100, ...base };
}
