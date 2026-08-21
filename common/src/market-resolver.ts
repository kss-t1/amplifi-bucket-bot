/**
 * Resolves a Polymarket tokenId against an Amplifi VM's ingested markets.
 * Amplifi only accepts opens on markets it has seen via
 * `MarketAutoIngestService`, so any tokenId that doesn't match a row here
 * gets skipped. Also exposes the full ingested market list to callers that
 * need to discover markets up-front (e.g. the bucket bot iterating BTC
 * dailies by slug).
 */
export interface AmplifiMarket {
  id: string;
  slug: string;
  name: string;
  tokenId: string;
  complementTokenId: string;
  conditionId: string;
  outcome: string;
  complementOutcome: string;
  /** Leverage cap if you buy the canonical YES (`tokenId`) side. */
  maxLeverage: number;
  /** Leverage cap if you buy the complement NO (`complementTokenId`) side.
   *  Optional for backward compat with API versions that don't yet emit it;
   *  consumers should fall back to `maxLeverage` when this is undefined. */
  noMaxLeverage?: number;
  /** Per-user notional cap on this market (USD), or null for no cap.
   *  Set by admin via the markets API; bot must clamp size to fit. */
  maxNotionalPerUser: number | null;
  category: string | null;
  endDate: string;
}

export interface ResolvedMarket {
  market: AmplifiMarket;
  outcome: "YES" | "NO";
}

export class MarketResolver {
  private byTokenId = new Map<
    string,
    { market: AmplifiMarket; isYes: boolean }
  >();
  private bySlug = new Map<string, AmplifiMarket>();
  private lastFetched = 0;

  constructor(
    private readonly apiBase: string,
    private readonly ttlMs = 60_000,
  ) {}

  private async refresh(): Promise<void> {
    const res = await fetch(`${this.apiBase}/polymarket/markets`);
    if (!res.ok) throw new Error(`amplifi /polymarket/markets ${res.status}`);
    const markets = (await res.json()) as AmplifiMarket[];
    this.byTokenId.clear();
    this.bySlug.clear();
    for (const m of markets) {
      this.byTokenId.set(m.tokenId, { market: m, isYes: true });
      this.byTokenId.set(m.complementTokenId, { market: m, isYes: false });
      this.bySlug.set(m.slug, m);
    }
    this.lastFetched = Date.now();
  }

  private async ensureFresh(): Promise<void> {
    if (Date.now() - this.lastFetched > this.ttlMs) await this.refresh();
  }

  async resolve(tokenId: string): Promise<ResolvedMarket | null> {
    await this.ensureFresh();
    const hit = this.byTokenId.get(tokenId);
    if (!hit) return null;
    return { market: hit.market, outcome: hit.isYes ? "YES" : "NO" };
  }

  /** Look up an ingested market by slug. Returns null if Amplifi hasn't
   *  ingested it yet (the bucket bot logs and skips these). */
  async bySlugLookup(slug: string): Promise<AmplifiMarket | null> {
    await this.ensureFresh();
    return this.bySlug.get(slug) ?? null;
  }
}
