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
): number | null {
  if (buffer.length < 2) return null;
  const last = buffer[buffer.length - 1]!;
  const from = last.ts - windowMs;
  const rets: number[] = [];
  for (const p of buffer) {
    if (p.ts < from) continue;
    const want = p.ts - HOUR;
    const prior = priceAt(buffer, want);
    if (prior === null || prior.price <= 0 || p.price <= 0) continue;
    if (want - prior.ts > maxLookbackSkewMs) continue;
    rets.push(Math.log(p.price / prior.price));
  }
  if (rets.length < minSamples) return null;
  const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr =
    rets.reduce((a, b) => a + (b - mu) * (b - mu), 0) / (rets.length - 1);
  return Math.sqrt(varr);
}

function priceAt(buffer: PricePoint[], ts: number): PricePoint | null {
  let found: PricePoint | null = null;
  for (const p of buffer) {
    if (p.ts <= ts) found = p;
    else break;
  }
  return found;
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
  hoursToResolution: number;
}

export function evaluateHeadroom(
  buffer: PricePoint[],
  strikeUsd: number,
  side: PositionSide,
  hoursToResolution: number,
  cfg: HeadroomConfig,
): HeadroomDecision {
  const spot = buffer.length > 0 ? buffer[buffer.length - 1]!.price : null;
  const vol = hourlyVol(buffer);
  const head = spot === null ? null : headroomFraction(spot, strikeUsd, side);
  const base = {
    headroomPct: head === null ? null : head * 100,
    hourlyVolPct: vol === null ? null : vol * 100,
    hoursToResolution,
  };
  if (vol === null || head === null)
    return { block: false, requiredPct: null, ...base };
  const hours = Math.max(0, hoursToResolution);
  const required =
    cfg.k * vol * (cfg.timeExponent === 0 ? 1 : hours ** cfg.timeExponent);
  return { block: head < required, requiredPct: required * 100, ...base };
}
