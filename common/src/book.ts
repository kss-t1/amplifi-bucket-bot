/**
 * Minimal CLOB REST orderbook reader. Returns best bid + best ask + tick
 * size per token. Polling, not WebSocket — the harvester ticks every few
 * seconds and ranks 5 strikes, so per-tick HTTPS is fine.
 *
 * Polymarket /book endpoint shape (verified live):
 *   { market, asset_id, hash, timestamp,
 *     bids: [{price: "0.42", size: "120"}, ...],
 *     asks: [{price: "0.43", size: "80"}, ...],
 *     tick_size: "0.01" }
 */
import { fetchWithTimeout } from "./http.ts";

const CLOB_BASE = "https://clob.polymarket.com";

export interface BookSnapshot {
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  tickSize: number;
  ts: number;
}

interface RawLevel {
  price: string;
  size: string;
}

interface RawBook {
  asset_id: string;
  bids: RawLevel[];
  asks: RawLevel[];
  tick_size?: string;
}

function topOfBook(levels: RawLevel[], side: "bid" | "ask"): number | null {
  if (!levels.length) return null;
  // CLOB returns bids ASCENDING (worst first) and asks DESCENDING (worst
  // first) — top of book is the LAST entry in both. Verified against
  // https://docs.polymarket.com/developers/CLOB/orders/orderbook
  let best: number | null = null;
  for (const lv of levels) {
    const p = Number(lv.price);
    if (!Number.isFinite(p) || Number(lv.size) <= 0) continue;
    if (best == null) {
      best = p;
      continue;
    }
    if (side === "bid" ? p > best : p < best) best = p;
  }
  return best;
}

export async function fetchBook(
  tokenId: string,
  defaultTickSize: number,
): Promise<BookSnapshot> {
  const res = await fetchWithTimeout(`${CLOB_BASE}/book?token_id=${tokenId}`);
  if (!res.ok) {
    throw new Error(`CLOB /book ${tokenId.slice(0, 12)} → ${res.status}`);
  }
  const raw = (await res.json()) as RawBook;
  return {
    tokenId,
    bestBid: topOfBook(raw.bids ?? [], "bid"),
    bestAsk: topOfBook(raw.asks ?? [], "ask"),
    tickSize: raw.tick_size ? Number(raw.tick_size) : defaultTickSize,
    ts: Date.now(),
  };
}

/** Multi-token fetch — CLOB exposes a single-token /book only, so we fan
 *  out. Concurrency is bounded by the caller (Promise.all in the bot is
 *  fine for ≤ 10 tokens per tick). */
export async function fetchBooks(
  tokenIds: string[],
  defaultTickSize: number,
): Promise<Map<string, BookSnapshot>> {
  const out = new Map<string, BookSnapshot>();
  const results = await Promise.allSettled(
    tokenIds.map((id) => fetchBook(id, defaultTickSize)),
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "fulfilled") out.set(tokenIds[i]!, r.value);
  }
  return out;
}

// 1e-9 epsilon to swallow IEEE-754 float noise — `(0.1 + 0.2) / 0.01` is
// 30.000000000000004, which would naively ceil to 31. Subtract before ceil
// and add before floor so a price already on-tick stays put.
const TICK_EPSILON = 1e-9;

/** Round a price UP to the nearest tick. Used when we want to undercut an
 *  ask (or sit one tick above best bid). */
export function ceilToTick(price: number, tick: number): number {
  return Number((Math.ceil(price / tick - TICK_EPSILON) * tick).toFixed(4));
}

/** Round a price DOWN to the nearest tick. Used when sitting AT best bid. */
export function floorToTick(price: number, tick: number): number {
  return Number((Math.floor(price / tick + TICK_EPSILON) * tick).toFixed(4));
}
