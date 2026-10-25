/**
 * Live BTC daily strikes (Gamma series 45) that resolve within the trading
 * window. Only the YES token is needed for pricing: the NO side buys at
 * 1 − YES bid, and an order on the NO token crosses those YES bids by minting.
 */
import {
  fetchEventsBySeriesId,
  parseStringArray,
  type GammaEvent,
} from "../../common/src/gamma.ts";

export const BTC_DAILY_SERIES_ID = 45;

export interface Strike {
  slug: string;
  conditionId: string;
  strikeUsd: number;
  yesTokenId: string;
  noTokenId: string;
  /** Resolution instant: Binance BTC/USDT 1m close at 12:00 New York time. */
  endMs: number;
  tickSize: number;
  minShares: number;
  negRisk: boolean;
}

/** Gamma fields this module reads beyond the shared GammaMarket shape. */
interface RawMarket {
  slug: string;
  conditionId: string;
  groupItemTitle?: string;
  clobTokenIds: string;
  endDate: string;
  closed: boolean;
  acceptingOrders?: boolean;
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  negRisk?: boolean;
}

/** 12:00 America/New_York on the given UTC calendar day. Polymarket resolves
 *  at noon ET, so the UTC hour moves with daylight saving (16:00 or 17:00). */
export function noonEasternMs(utcDay: Date): number {
  const y = utcDay.getUTCFullYear();
  const m = utcDay.getUTCMonth();
  const d = utcDay.getUTCDate();
  const hourIn = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hourCycle: "h23",
  });
  for (const utcHour of [16, 17]) {
    const ms = Date.UTC(y, m, d, utcHour);
    if (Number(hourIn.format(ms)) === 12) return ms;
  }
  throw new Error(`no noon ET on ${utcDay.toISOString().slice(0, 10)}`);
}

export function strikesFromEvents(events: GammaEvent[]): Strike[] {
  const out: Strike[] = [];
  for (const ev of events) {
    for (const raw of ev.markets ?? []) {
      const m = raw as unknown as RawMarket;
      if (m.closed || m.acceptingOrders === false) continue;
      const strikeUsd = Number((m.groupItemTitle ?? "").replace(/,/g, ""));
      const tokens = parseStringArray(m.clobTokenIds);
      const end = Date.parse(m.endDate ?? ev.endDate);
      if (!(strikeUsd > 0) || tokens?.length !== 2 || !Number.isFinite(end)) continue;
      out.push({
        slug: m.slug,
        conditionId: m.conditionId,
        strikeUsd,
        yesTokenId: tokens[0]!,
        noTokenId: tokens[1]!,
        endMs: noonEasternMs(new Date(end)),
        tickSize: Number(m.orderPriceMinTickSize) || 0.01,
        minShares: Number(m.orderMinSize) || 5,
        negRisk: !!m.negRisk,
      });
    }
  }
  return out.sort((a, b) => a.endMs - b.endMs || a.strikeUsd - b.strikeUsd);
}

export async function fetchTradableStrikes(
  nowMs: number,
  maxHoursLeft: number,
  minSecondsLeft: number,
): Promise<Strike[]> {
  const events = await fetchEventsBySeriesId(BTC_DAILY_SERIES_ID, { closed: false });
  return strikesFromEvents(events).filter(
    (s) =>
      s.endMs - nowMs > minSecondsLeft * 1000 &&
      s.endMs - nowMs <= maxHoursLeft * 3_600_000,
  );
}
