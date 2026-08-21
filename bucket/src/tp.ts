/**
 * Pure helpers for the optional take-profit feature.
 *
 * Split out so the price math can be exercised in unit tests without
 * standing up the full BucketBot fixture (Amplifi client, state file,
 * resolver, etc.).
 */
import { ceilToTick, floorToTick } from "../../common/src/book.ts";

export type TpDecision =
  | { kind: "set"; tpPrice: number }
  | { kind: "skip"; reason: "out-of-range"; tpRaw: number; tpTick: number };

/** Default take-profit price used when `tpRoePct` is unset. Picked to book
 *  the bulk of profit on positions that would otherwise ride to resolution,
 *  freeing collateral so the allocator can redeploy it sooner. */
export const DEFAULT_TP_PRICE = 0.999;

/**
 * The price to anchor TP math on: the captured fill price when it's a real
 * positive value, otherwise the limit/target price as a stand-in.
 *
 * Guards the `0` fill-price trap: a taker open whose entry price isn't
 * returned synchronously persists `fillPrice = 0`, and `fillPrice ?? limitPrice`
 * does NOT fall back (0 is not nullish) — it returns 0, which fails the
 * `> 0` gate and silently skips the take-profit forever. An explicit `> 0`
 * check routes those slots to the limit-price stand-in instead.
 */
export function tpAnchorPrice(
  fillPrice: number | null | undefined,
  limitPrice: number,
): number {
  return fillPrice && fillPrice > 0 ? fillPrice : limitPrice;
}

/**
 * Compute the take-profit price that yields `roePct` return on collateral.
 *
 *   roePct/100 = leverage × (tpPrice/fillPrice − 1)
 *   ⇒ tpPrice = fillPrice × (1 + roePct / (leverage × 100))
 *
 * Result is ceiled UP to `tickSize` (TP must be strictly above fillPrice
 * to actually realize profit; rounding down would leave it on or below
 * the fill price). Returns `skip` when the rounded TP lands outside the
 * CLOB-valid range (fillPrice, 1 − tickSize] — Polymarket only accepts
 * orders strictly inside (0, 1).
 */
export function computeTpPrice(args: {
  fillPrice: number;
  leverage: number;
  roePct: number;
  tickSize: number;
}): TpDecision {
  const { fillPrice, leverage, roePct, tickSize } = args;
  const tpRaw = fillPrice * (1 + roePct / (leverage * 100));
  const tpTick = ceilToTick(tpRaw, tickSize);
  const tpCap = Number((1 - tickSize).toFixed(4));
  if (!(tpTick > fillPrice && tpTick <= tpCap)) {
    return { kind: "skip", reason: "out-of-range", tpRaw, tpTick };
  }
  return { kind: "set", tpPrice: tpTick };
}

/** Compute a fixed-price take-profit, snapped DOWN to the side's tick so
 *  the order rests at or below the requested target (never above). Returns
 *  `skip` if the snapped price is <= fillPrice or outside the CLOB-valid
 *  range (0, 1 − tickSize]. Used when the operator hasn't configured an
 *  ROE-based TP — the bot still wants to free capital before resolution. */
export function computeFixedTpPrice(args: {
  fillPrice: number;
  targetPrice: number;
  tickSize: number;
}): TpDecision {
  const { fillPrice, targetPrice, tickSize } = args;
  const tpTick = floorToTick(targetPrice, tickSize);
  const tpCap = Number((1 - tickSize).toFixed(4));
  if (!(tpTick > fillPrice && tpTick <= tpCap)) {
    return { kind: "skip", reason: "out-of-range", tpRaw: targetPrice, tpTick };
  }
  return { kind: "set", tpPrice: tpTick };
}

/**
 * Pick the take-profit decision for a slot.
 *
 * - `roePct` unset → fixed `DEFAULT_TP_PRICE`.
 * - `roePct` set → the ROE-on-collateral price, BUT when that target lands
 *   out of the CLOB-valid range it falls back to the fixed `DEFAULT_TP_PRICE`
 *   instead of skipping. This happens in deep-ITM buckets at low leverage:
 *   e.g. fill 0.989 at lev 2 with roePct 5 → target 1.014, an impossible sell
 *   price. The fixed fallback (0.999) still books the bulk of the profit and
 *   frees collateral rather than abandoning the slot to ride to resolution.
 * - `forceFixed` → skip straight to the fixed price. Used after the book has
 *   already bid past the ROE target (setTakeProfit rejected with "must be
 *   above current best bid"); the higher fixed price rests above the bid.
 *
 * Returns `skip` only when even the fixed price is out of range (fill already
 * ≥ 1 − tickSize), in which case the slot genuinely rides to resolution.
 */
export function chooseTpDecision(args: {
  fillPrice: number;
  leverage: number;
  roePct: number | null | undefined;
  tickSize: number;
  forceFixed?: boolean;
}): TpDecision {
  const { fillPrice, leverage, roePct, tickSize, forceFixed } = args;
  if (roePct == null || forceFixed) {
    return computeFixedTpPrice({
      fillPrice,
      targetPrice: DEFAULT_TP_PRICE,
      tickSize,
    });
  }
  const roe = computeTpPrice({ fillPrice, leverage, roePct, tickSize });
  if (roe.kind === "set") return roe;
  return computeFixedTpPrice({
    fillPrice,
    targetPrice: DEFAULT_TP_PRICE,
    tickSize,
  });
}
