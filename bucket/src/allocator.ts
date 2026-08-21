/**
 * Pure allocation math for the bucket bot.
 *
 * Inputs: 6 Gamma daily events (ordered by expiry, soonest first), the
 * derived current-BTC strike, total capital, and a config bundle.
 *
 * Output: a list of target positions — one per (event, strike, side) that
 * qualifies under the price-bucket filter, sized by:
 *
 *   day_weight × total_capital × within_day_share
 *
 * Day weights are fixed at [0.40, 0.25, 0.125, 0.075, 0.075, 0.075]. Within
 * a day, the user spec is "equal across all qualifying markets" unless the
 * `restricted` toggle is on, in which case the day's share is first split
 * 50/50 between strikes-above-BTC and strikes-below-BTC, then equally
 * inside each half.
 *
 * Empty days hold cash (no auto-rebalance into other days) — keeps the
 * bot's exposure profile predictable from one poll to the next, and avoids
 * the "concentrate everything on a single far-dated market when the near
 * ones are sleepy" failure mode.
 */
import type { BtcDailyEvent, BtcDailyStrike } from "./btc-daily.ts";
import { expectedRoiOnCollateral } from "./lending-pool.ts";

export type Bucket = "0.90-0.95" | "0.95-0.97" | "0.97-0.99" | "0.99+";

export const DEFAULT_DAY_WEIGHTS: readonly number[] = [
  0.4, 0.25, 0.125, 0.075, 0.075, 0.075,
];

export interface LeveragePerBucket {
  "0.90-0.95": number;
  "0.95-0.97": number;
  "0.97-0.99": number;
  "0.99+": number;
}

/** Per-bucket hours-to-resolution bound. `undefined` for a bucket = no bound
 *  for that bucket. Used for both the max (skip too-far entries) and the min
 *  (skip too-close-to-settlement entries) gates. */
export interface HoursPerBucket {
  "0.90-0.95": number | undefined;
  "0.95-0.97": number | undefined;
  "0.97-0.99": number | undefined;
  "0.99+": number | undefined;
}

export interface AllocatorConfig {
  totalCapitalUsd: number;
  restricted: boolean;
  leveragePerBucket: LeveragePerBucket;
  /** Buckets to consider. Default: all three. */
  allowedBuckets: ReadonlySet<Bucket>;
  /** Day weights — caller can override but must be the same length as the
   *  events array passed in. Trailing zeroes are legal (hold cash). */
  dayWeights: readonly number[];
  /** Hard ceiling on entry price. Strikes whose qualifying side is >= this
   *  are dropped entirely. Designed for the deep-ITM band where leveraged
   *  upside (1/p−1) shrinks below the floor of the interest cost. Default
   *  unset (no ceiling). */
  maxEntryPrice?: number;
  /** Interest-aware ROI gate. When `apr` is set, qualifying strikes must
   *  return at least `minRoiPct/100` on collateral after interest costs
   *  through to resolution. */
  roiGate?: {
    /** Decimal APR (0.30 = 30%). */
    aprDecimal: number;
    /** Minimum ROI on collateral, decimal (0.02 = 2%). */
    minRoi: number;
    /** Reference time the allocator uses to compute hours-to-resolution
     *  from each event's endDate. */
    now: Date;
  };
  /** Reference time for the per-bucket hours-to-resolution gates below.
   *  Falls back to `roiGate.now` when unset. Required if either
   *  `maxHoursPerBucket` or `minHoursPerBucket` is set. */
  now?: Date;
  /** Per-bucket cap on hours-to-resolution at open. A qualifying strike is
   *  dropped (reason `max-hours`) when its event resolves further out than
   *  its bucket's cap. Deep buckets (0.97-0.99) bleed when opened far from
   *  resolution; shallow buckets tolerate longer windows. undefined = no cap. */
  maxHoursPerBucket?: HoursPerBucket;
  /** Per-bucket floor on hours-to-resolution at open. A qualifying strike is
   *  dropped (reason `min-hours`) when its event resolves sooner than its
   *  bucket's floor — too close to settlement, where books thin/clear and
   *  fills/triggers get noisy. undefined = no floor. */
  minHoursPerBucket?: HoursPerBucket;
  /** Optional cap on per-target collateral. Days with many qualifying
   *  strikes won't over-concentrate when this is set; unused capital
   *  stays idle. Default unset (no cap). */
  maxPositionCollateralUsd?: number;
}

export interface AllocationTarget {
  eventSlug: string;
  marketSlug: string;
  conditionId: string;
  tokenId: string;
  outcome: "YES" | "NO";
  /** Mid-price of the side we'd be buying (from Gamma outcomePrices). */
  entryPriceMid: number;
  strikeUsd: number;
  bucket: Bucket;
  leverage: number;
  collateralUsd: number;
  /** Day index in the input events array (0 = soonest). */
  dayIndex: number;
}

export function priceToBucket(price: number): Bucket | null {
  if (price < 0.9 || price >= 1) return null;
  if (price < 0.95) return "0.90-0.95";
  if (price < 0.97) return "0.95-0.97";
  if (price < 0.99) return "0.97-0.99";
  return "0.99+";
}

interface QualifyingMarket {
  strike: BtcDailyStrike;
  outcome: "YES" | "NO";
  qualifyingPrice: number;
  bucket: Bucket;
}

export interface DroppedMarket {
  marketSlug: string;
  outcome: "YES" | "NO";
  qualifyingPrice: number;
  reason: "max-entry-price" | "roi-below-min" | "max-hours" | "min-hours";
  details?: Record<string, unknown>;
}

/**
 * For an event, returns the strikes whose qualifying side (YES if strike
 * is below current BTC, NO if above) sits in one of the allowed buckets.
 * The ATM strike (strike == currentBtcStrike) is skipped — neither side
 * is decisively above-trading or below-trading, and its prices are too
 * far from the 0.9+ bucket to qualify anyway in normal conditions.
 *
 * Two extra gates are applied here so they take effect BEFORE the day's
 * budget is divided across surviving markets:
 *   - `maxEntryPrice`: drop strikes whose qualifying price has effectively
 *     no upside left (1/p−1 below the bot's economic floor).
 *   - `roiGate`: drop strikes where leveraged upside through to resolution
 *     doesn't beat the borrow interest by `minRoi`.
 * Dropped strikes are emitted separately so the operator can see WHY a
 * day went under-deployed.
 */
function findQualifying(
  event: BtcDailyEvent,
  currentBtcStrike: number,
  allowed: ReadonlySet<Bucket>,
  cfg: AllocatorConfig,
): { qualifying: QualifyingMarket[]; dropped: DroppedMarket[] } {
  const out: QualifyingMarket[] = [];
  const dropped: DroppedMarket[] = [];
  const eventEndMs = new Date(event.endDate).getTime();
  for (const s of event.strikes) {
    if (s.closed) continue;
    if (s.strikeUsd === currentBtcStrike) continue;
    const isBelow = s.strikeUsd < currentBtcStrike;
    const outcome: "YES" | "NO" = isBelow ? "YES" : "NO";
    const qPrice = isBelow ? s.yesPrice : s.noPrice;
    const bucket = priceToBucket(qPrice);
    if (!bucket || !allowed.has(bucket)) continue;

    // Hours-to-resolution at open. All strikes in an event share its endDate,
    // but the applicable bound is per-bucket, so this is computed per strike.
    // Shared by the per-bucket time gates and the ROI gate below.
    const refNow = cfg.now ?? cfg.roiGate?.now;
    const hoursToResolution =
      refNow !== undefined
        ? Math.max(0, (eventEndMs - refNow.getTime()) / 3_600_000)
        : undefined;

    if (cfg.maxEntryPrice !== undefined && qPrice >= cfg.maxEntryPrice) {
      dropped.push({
        marketSlug: s.slug,
        outcome,
        qualifyingPrice: qPrice,
        reason: "max-entry-price",
        details: { maxEntryPrice: cfg.maxEntryPrice },
      });
      continue;
    }

    const maxHours = cfg.maxHoursPerBucket?.[bucket];
    if (
      maxHours !== undefined &&
      hoursToResolution !== undefined &&
      hoursToResolution > maxHours
    ) {
      dropped.push({
        marketSlug: s.slug,
        outcome,
        qualifyingPrice: qPrice,
        reason: "max-hours",
        details: {
          hoursToResolution: hoursToResolution.toFixed(2),
          maxHours,
          bucket,
        },
      });
      continue;
    }

    const minHours = cfg.minHoursPerBucket?.[bucket];
    if (
      minHours !== undefined &&
      hoursToResolution !== undefined &&
      hoursToResolution < minHours
    ) {
      dropped.push({
        marketSlug: s.slug,
        outcome,
        qualifyingPrice: qPrice,
        reason: "min-hours",
        details: {
          hoursToResolution: hoursToResolution.toFixed(2),
          minHours,
          bucket,
        },
      });
      continue;
    }

    if (cfg.roiGate) {
      const leverage = cfg.leveragePerBucket[bucket];
      const roi = expectedRoiOnCollateral({
        entryPrice: qPrice,
        leverage,
        aprDecimal: cfg.roiGate.aprDecimal,
        hoursToResolution: hoursToResolution ?? 0,
      });
      if (roi < cfg.roiGate.minRoi) {
        dropped.push({
          marketSlug: s.slug,
          outcome,
          qualifyingPrice: qPrice,
          reason: "roi-below-min",
          details: {
            roiPct: (roi * 100).toFixed(3),
            minRoiPct: (cfg.roiGate.minRoi * 100).toFixed(3),
            hoursToResolution: (hoursToResolution ?? 0).toFixed(2),
            leverage,
          },
        });
        continue;
      }
    }

    out.push({ strike: s, outcome, qualifyingPrice: qPrice, bucket });
  }
  return { qualifying: out, dropped };
}

/**
 * Picks the strike whose YES price is closest to 0.50 — our proxy for
 * current BTC. Returns null on an empty event (no usable strikes).
 *
 * For tied distances we prefer the lower strike, which keeps "below current"
 * deterministic when YES sits exactly on 0.50 (very rare, but matters for
 * the restricted-mode 50/50 split).
 */
export function inferCurrentBtcStrike(event: BtcDailyEvent): number | null {
  let best: BtcDailyStrike | null = null;
  let bestDist = Infinity;
  for (const s of event.strikes) {
    if (s.closed) continue;
    const dist = Math.abs(s.yesPrice - 0.5);
    // Strict-less-than alone would make the tie-break order-dependent;
    // explicitly prefer the lower strike so the restricted-mode 50/50
    // split stays deterministic if `event.strikes` ever ships unsorted.
    if (
      dist < bestDist ||
      (dist === bestDist && best !== null && s.strikeUsd < best.strikeUsd)
    ) {
      best = s;
      bestDist = dist;
    }
  }
  return best?.strikeUsd ?? null;
}

export interface AllocationResult {
  targets: AllocationTarget[];
  /** Per-day notes the operator can log: how much was deployed vs held. */
  daySummaries: Array<{
    dayIndex: number;
    eventSlug: string | null;
    weight: number;
    dayBudgetUsd: number;
    deployedUsd: number;
    qualifyingMarkets: number;
    droppedMarkets: number;
    /** "no-event" | "no-qualifying" | "deployed" | "partial-restricted". */
    status: string;
  }>;
  /** Strikes that survived bucket selection but got filtered by
   *  `maxEntryPrice` / `roiGate`. Emitted for operator visibility — these
   *  are the markets the new "don't open without enough upside" rules cut. */
  droppedMarkets: DroppedMarket[];
}

/**
 * Compute target allocations. `events[i]` is the event for day i (0 = next
 * to resolve). A null entry means Gamma had no event for that day (we hold
 * the day's cash). `currentBtcStrikePerDay[i]` should be the ATM strike
 * for the same event, or null if undetermined.
 */
export function allocate(
  events: ReadonlyArray<BtcDailyEvent | null>,
  currentBtcStrikePerDay: ReadonlyArray<number | null>,
  cfg: AllocatorConfig,
): AllocationResult {
  if (events.length !== cfg.dayWeights.length) {
    throw new Error(
      `allocator: events.length (${events.length}) != dayWeights.length (${cfg.dayWeights.length})`,
    );
  }
  if (events.length !== currentBtcStrikePerDay.length) {
    throw new Error(
      `allocator: events.length (${events.length}) != currentBtcStrikePerDay.length (${currentBtcStrikePerDay.length})`,
    );
  }

  const targets: AllocationTarget[] = [];
  const daySummaries: AllocationResult["daySummaries"] = [];
  const allDropped: DroppedMarket[] = [];

  const clampToCap = (amount: number): number =>
    cfg.maxPositionCollateralUsd !== undefined
      ? Math.min(amount, cfg.maxPositionCollateralUsd)
      : amount;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i] ?? null;
    const weight = cfg.dayWeights[i]!;
    const dayBudget = cfg.totalCapitalUsd * weight;

    if (!ev) {
      daySummaries.push({
        dayIndex: i,
        eventSlug: null,
        weight,
        dayBudgetUsd: dayBudget,
        deployedUsd: 0,
        qualifyingMarkets: 0,
        droppedMarkets: 0,
        status: "no-event",
      });
      continue;
    }

    const atm = currentBtcStrikePerDay[i] ?? null;
    if (atm === null) {
      daySummaries.push({
        dayIndex: i,
        eventSlug: ev.slug,
        weight,
        dayBudgetUsd: dayBudget,
        deployedUsd: 0,
        qualifyingMarkets: 0,
        droppedMarkets: 0,
        status: "no-atm",
      });
      continue;
    }

    const { qualifying, dropped } = findQualifying(
      ev,
      atm,
      cfg.allowedBuckets,
      cfg,
    );
    allDropped.push(...dropped);
    if (qualifying.length === 0) {
      daySummaries.push({
        dayIndex: i,
        eventSlug: ev.slug,
        weight,
        dayBudgetUsd: dayBudget,
        deployedUsd: 0,
        qualifyingMarkets: 0,
        droppedMarkets: dropped.length,
        status: dropped.length > 0 ? "all-filtered" : "no-qualifying",
      });
      continue;
    }

    const below = qualifying.filter((q) => q.outcome === "YES");
    const above = qualifying.filter((q) => q.outcome === "NO");

    let dayTargets: AllocationTarget[] = [];
    let status: string;

    if (cfg.restricted) {
      // 50/50 split between above-BTC and below-BTC categories. If one
      // category is empty, hold the cash for that half — the whole point
      // of the restriction is delta-balance, so single-sided exposure
      // here defeats it.
      const halfBudget = dayBudget / 2;
      if (below.length > 0) {
        const each = clampToCap(halfBudget / below.length);
        for (const q of below)
          dayTargets.push(makeTarget(ev, q, each, cfg.leveragePerBucket, i));
      }
      if (above.length > 0) {
        const each = clampToCap(halfBudget / above.length);
        for (const q of above)
          dayTargets.push(makeTarget(ev, q, each, cfg.leveragePerBucket, i));
      }
      status =
        below.length > 0 && above.length > 0
          ? "deployed"
          : "partial-restricted";
    } else {
      const each = clampToCap(dayBudget / qualifying.length);
      for (const q of qualifying)
        dayTargets.push(makeTarget(ev, q, each, cfg.leveragePerBucket, i));
      status = "deployed";
    }

    const deployed = dayTargets.reduce((s, t) => s + t.collateralUsd, 0);
    targets.push(...dayTargets);
    daySummaries.push({
      dayIndex: i,
      eventSlug: ev.slug,
      weight,
      dayBudgetUsd: dayBudget,
      deployedUsd: deployed,
      qualifyingMarkets: qualifying.length,
      droppedMarkets: dropped.length,
      status,
    });
  }

  return { targets, daySummaries, droppedMarkets: allDropped };
}

function makeTarget(
  ev: BtcDailyEvent,
  q: QualifyingMarket,
  collateralUsd: number,
  leveragePerBucket: LeveragePerBucket,
  dayIndex: number,
): AllocationTarget {
  return {
    eventSlug: ev.slug,
    marketSlug: q.strike.slug,
    conditionId: q.strike.conditionId,
    tokenId: q.outcome === "YES" ? q.strike.yesTokenId : q.strike.noTokenId,
    outcome: q.outcome,
    entryPriceMid: q.qualifyingPrice,
    strikeUsd: q.strike.strikeUsd,
    bucket: q.bucket,
    leverage: leveragePerBucket[q.bucket],
    collateralUsd,
    dayIndex,
  };
}
