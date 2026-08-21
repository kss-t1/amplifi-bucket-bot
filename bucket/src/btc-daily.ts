/**
 * BTC daily-above strategy primitives. Wraps the generic Gamma event
 * fetcher (`bots/common/src/gamma.ts`) with the bucket-bot-specific
 * series filter and strike parsing.
 *
 * Event discovery is driven by Gamma `series_id` (default 45 =
 * btc-multi-strikes-weekly), not by slug guessing. The previous slug-based
 * approach (`bitcoin-above-on-{month}-{day}`) silently broke when
 * Polymarket appended a year segment to new events in May 2026 — slugs
 * like `bitcoin-above-on-may-22-2026` returned empty arrays under the
 * old `?slug=` query. Series-id discovery is slug-rename immune.
 *
 * See `.claude/rules/gotchas.md` "Gamma slug renames" for context.
 */
import {
  fetchEventsBySeriesId,
  parseStringArray,
  type GammaEvent,
} from "../../common/src/gamma.ts";

/** Gamma series id for the daily Bitcoin-above-strike multi-market series.
 *  Inspect via `event.series[0].id` on any daily-above event. Override via
 *  `BTC_DAILY_SERIES_ID` env if Polymarket ever reshuffles series ids. */
export const DEFAULT_BTC_DAILY_SERIES_ID = 45;

export interface BtcDailyStrike {
  conditionId: string;
  slug: string;
  groupItemTitle: string; // e.g. "78,000"
  strikeUsd: number;
  yesTokenId: string;
  noTokenId: string;
  yesPrice: number;
  noPrice: number;
  closed: boolean;
}

export interface BtcDailyEvent {
  slug: string;
  endDate: string;
  strikes: BtcDailyStrike[];
}

function parseStrikeFromTitle(title: string): number | null {
  // groupItemTitle is "78,000" / "100,000" / etc. Strip commas, parse.
  const n = Number(title.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function eventToDailyEvent(ev: GammaEvent): BtcDailyEvent {
  const strikes: BtcDailyStrike[] = [];
  for (const m of ev.markets ?? []) {
    const strike = parseStrikeFromTitle(m.groupItemTitle ?? "");
    if (strike === null) continue;
    const prices = parseStringArray(m.outcomePrices);
    const tokens = parseStringArray(m.clobTokenIds);
    if (!prices || prices.length !== 2) continue;
    if (!tokens || tokens.length !== 2) continue;
    const yesPrice = Number(prices[0]);
    const noPrice = Number(prices[1]);
    if (!Number.isFinite(yesPrice) || !Number.isFinite(noPrice)) continue;
    strikes.push({
      conditionId: m.conditionId,
      slug: m.slug,
      groupItemTitle: m.groupItemTitle ?? "",
      strikeUsd: strike,
      yesTokenId: tokens[0]!,
      noTokenId: tokens[1]!,
      yesPrice,
      noPrice,
      closed: !!m.closed,
    });
  }
  strikes.sort((a, b) => a.strikeUsd - b.strikeUsd);
  return { slug: ev.slug, endDate: ev.endDate, strikes };
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** Build a `bitcoin-above-on-{month}-{day}` slug for a UTC date. Only
 *  exported for the historical-outreach script — the live bot uses
 *  `fetchUpcomingBtcDailyEvents` (series-id discovery) instead, because
 *  slug-based lookup misses events Polymarket has renamed (e.g. the
 *  year-suffixed `bitcoin-above-on-may-22-2026`). */
export function dailyEventSlug(date: Date): string {
  const month = MONTHS[date.getUTCMonth()]!;
  const day = date.getUTCDate();
  return `bitcoin-above-on-${month}-${day}`;
}

/**
 * Fetch upcoming daily-above events and bin them by calendar day. Returns
 * a length-`days` array where index `i` is the event resolving on the i-th
 * forward calendar day (or null if Polymarket has no event that day).
 *
 * The calendar-day mapping is load-bearing: the allocator pairs index `i`
 * with `dayWeights[i]` and expects null at index i to mean "hold cash for
 * day i". A pack-and-slice approach (sort by endDate, take first N) would
 * silently shift later events into earlier weight slots when Polymarket
 * skips a day — e.g. a 4-day-out event inheriting the <24h budget.
 *
 * Throws on Gamma network/5xx so the caller can decide whether to retry.
 */
export async function fetchUpcomingBtcDailyEvents(
  now: Date,
  days: number,
  opts: { gammaBase?: string; seriesId?: number } = {},
): Promise<(BtcDailyEvent | null)[]> {
  const seriesId = opts.seriesId ?? DEFAULT_BTC_DAILY_SERIES_ID;
  const events = await fetchEventsBySeriesId(seriesId, {
    gammaBase: opts.gammaBase,
    closed: false,
  });

  // Index Gamma events by UTC calendar day of their resolution time.
  // Daily-above events resolve at 16:00 UTC, so the YYYY-MM-DD prefix of
  // endDate is the unique day key.
  const byDayKey = new Map<string, GammaEvent>();
  for (const e of events) {
    const endMs = Date.parse(e.endDate);
    if (!Number.isFinite(endMs)) continue;
    const key = new Date(endMs).toISOString().slice(0, 10);
    byDayKey.set(key, e);
  }

  // Walk forward day-by-day from today's 16:00 UTC. If today's resolution
  // has already fired, index 0 is tomorrow's event (genuinely <24h).
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 16, 0),
  );
  const startOffset = now.getTime() >= todayUtc.getTime() ? 1 : 0;
  const result: (BtcDailyEvent | null)[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(todayUtc.getTime());
    d.setUTCDate(d.getUTCDate() + startOffset + i);
    const key = d.toISOString().slice(0, 10);
    const ev = byDayKey.get(key);
    result.push(ev ? eventToDailyEvent(ev) : null);
  }
  return result;
}
