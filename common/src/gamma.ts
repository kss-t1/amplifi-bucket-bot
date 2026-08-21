/**
 * Generic Polymarket Gamma API helpers. Anything strategy-specific
 * (BTC daily-above slug derivation, NBA market filters, etc.) belongs in
 * the bot's own module; this file is the thin wire-shape + fetch layer.
 *
 * Gamma's `/events?slug=<slug>` returns a 0- or 1-element array of events;
 * each event has a `markets[]` list (e.g. 11 strike sub-markets per daily
 * BTC-above event). The `outcomePrices` and `clobTokenIds` fields are
 * JSON-encoded *strings* of `["yes", "no"]` pairs — parse with care.
 */

export interface GammaEvent {
  id: string;
  slug: string;
  ticker?: string;
  title?: string;
  endDate: string;
  closed: boolean;
  markets: GammaMarket[];
}

export interface GammaMarket {
  id: string;
  conditionId: string;
  slug: string;
  question?: string;
  groupItemTitle?: string;
  /** JSON-encoded `["<yesPrice>", "<noPrice>"]`. Use `parseStringArray`. */
  outcomePrices: string;
  /** JSON-encoded `["<yesTokenId>", "<noTokenId>"]`. */
  clobTokenIds: string;
  /** JSON-encoded `["Yes", "No"]`. */
  outcomes: string;
  endDate: string;
  closed: boolean;
}

/** Parse one of Gamma's JSON-encoded array strings, e.g.
 *  `"[\"0.53\",\"0.47\"]"` → `["0.53", "0.47"]`. Returns null on
 *  malformed input rather than throwing — callers usually want to skip
 *  the row, not abort the whole event. */
export function parseStringArray(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    return arr.map((x) => String(x));
  } catch {
    return null;
  }
}

/**
 * Fetch a single Gamma event by slug. Returns null when the array is
 * empty (slug doesn't exist / not yet indexed). Throws on network or 5xx
 * so the caller can decide whether to retry; 4xx is wrapped into the same
 * error shape.
 */
export async function fetchEventBySlug(
  slug: string,
  gammaBase = "https://gamma-api.polymarket.com",
): Promise<GammaEvent | null> {
  const url = `${gammaBase}/events?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`gamma ${slug}: ${res.status}`);
  const data = (await res.json()) as GammaEvent[];
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0] ?? null;
}

/**
 * Fetch all events in a Gamma series. Slug-rename-immune (series id is
 * stable across slug renames, e.g. when Polymarket appended a year segment
 * to btc daily-above slugs in May 2026 — see gotchas.md).
 *
 * `closed=false` filters to upcoming/active events by default; callers
 * needing historical events can override `closed`.
 */
export async function fetchEventsBySeriesId(
  seriesId: number,
  opts: {
    gammaBase?: string;
    closed?: boolean;
    /** Max events to ask Gamma for. Gamma silently clamps to 100. */
    limit?: number;
  } = {},
): Promise<GammaEvent[]> {
  const gammaBase = opts.gammaBase ?? "https://gamma-api.polymarket.com";
  const closed = opts.closed ?? false;
  const limit = opts.limit ?? 100;
  const url = `${gammaBase}/events?series_id=${seriesId}&closed=${closed}&limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`gamma series ${seriesId}: ${res.status}`);
  const data = (await res.json()) as GammaEvent[];
  return Array.isArray(data) ? data : [];
}
