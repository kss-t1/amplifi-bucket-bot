/**
 * Per-(marketSlug, outcome) bucket-stability tracker.
 *
 * The bucket bot opens leveraged longs at deep-ITM prices on the assumption
 * those prices reflect a settled outcome. A market that briefly DIPPED into
 * the bucket and bounces back out is exactly the case where the bot used to
 * get liquidated — entering at 0.97 and watching it slide back to 0.90 within
 * minutes. The stability check enforces "price has been in this bucket for at
 * least N minutes straight" before the bot is willing to commit capital.
 *
 * Implementation: O(1) memory per (slug, outcome). For each observed sample
 * we keep the current `bucket` (or `null` if outside any allowed bucket /
 * data missing) and the timestamp the price ENTERED that bucket. Any
 * observed bucket change resets `sinceMs`. Stale entries — markets we
 * haven't seen in `stalenessMs` — are pruned by `prune()` (called from the
 * bot loop, NOT in the hot path).
 *
 * Pure / framework-free so it's trivially testable.
 */

export type BucketLabel = string;

export interface StabilityEntry {
  /** Most recently observed bucket label for this (slug, outcome). `null`
   *  when the price was outside any allowed bucket on the latest poll. */
  bucket: BucketLabel | null;
  /** ms epoch at which we FIRST observed the current `bucket`. Reset every
   *  time `bucket` changes. */
  sinceMs: number;
  /** ms epoch of the most recent observation, used by `prune()`. */
  lastSeenMs: number;
}

export interface StabilityState {
  /** Keyed by `${slug}|${outcome}`. */
  byKey: Record<string, StabilityEntry>;
}

export const emptyStabilityState = (): StabilityState => ({ byKey: {} });

export function stabilityKey(slug: string, outcome: "YES" | "NO"): string {
  return `${slug}|${outcome}`;
}

/**
 * Record one observation. The streak is reset (sinceMs := nowMs) when:
 *   - the observed bucket changed, OR
 *   - the gap since the previous observation exceeds `maxGapMs` (long
 *     pause / restart with stale persisted state).
 * Otherwise just refresh `lastSeenMs` and leave the streak running.
 *
 * The gap-reset in `observe` is what makes the stability gate actually
 * survive a restart. Without it, `observe` + `isStable` running in the
 * same poll cycle would render every gap check tautological — `observe`
 * refreshes `lastSeenMs` to `nowMs`, and `isStable`'s `nowMs −
 * lastSeenMs > maxGapMs` test never fires. The gap check in `isStable`
 * stays as defense-in-depth for callers that read state without first
 * calling `observe` in the same tick.
 */
export function observe(
  state: StabilityState,
  slug: string,
  outcome: "YES" | "NO",
  bucket: BucketLabel | null,
  nowMs: number,
  maxGapMs: number,
): void {
  const key = stabilityKey(slug, outcome);
  const prev = state.byKey[key];
  const gapTooLong = prev != null && nowMs - prev.lastSeenMs > maxGapMs;
  if (!prev || prev.bucket !== bucket || gapTooLong) {
    state.byKey[key] = { bucket, sinceMs: nowMs, lastSeenMs: nowMs };
    return;
  }
  prev.lastSeenMs = nowMs;
}

/**
 * Returns true iff the bot has continuously observed `requiredBucket` for at
 * least `minDurationMs` ending at `nowMs`. A gap (no observation) longer
 * than `maxGapMs` invalidates the streak — without this, a bot that woke
 * back up after a 4-hour pause would immediately fire opens on whatever
 * the current bucket happened to be.
 */
export function isStable(
  state: StabilityState,
  slug: string,
  outcome: "YES" | "NO",
  requiredBucket: BucketLabel,
  minDurationMs: number,
  maxGapMs: number,
  nowMs: number,
): boolean {
  const entry = state.byKey[stabilityKey(slug, outcome)];
  if (!entry) return false;
  if (entry.bucket !== requiredBucket) return false;
  if (nowMs - entry.lastSeenMs > maxGapMs) return false;
  return nowMs - entry.sinceMs >= minDurationMs;
}

/**
 * Drop entries we haven't observed in `stalenessMs`. Keeps the buffer from
 * growing unbounded across days of Gamma churn (closed markets, slug
 * renames, etc.).
 */
export function prune(
  state: StabilityState,
  nowMs: number,
  stalenessMs: number,
): void {
  for (const [key, entry] of Object.entries(state.byKey)) {
    if (nowMs - entry.lastSeenMs > stalenessMs) {
      delete state.byKey[key];
    }
  }
}
