/**
 * Buys BTC daily favourites when a fresh Binance move leaves the Polymarket
 * quote behind fair value, and holds them to resolution.
 */
import { appendFile } from "node:fs/promises";
import type { Hex } from "viem";
import type { Logger } from "../../common/src/amplifi-client.ts";
import { fairValue } from "../../common/src/fair-value.ts";
import { BTC_FAIR_VALUE_PARAMS } from "../../common/src/btc-fair-value-params.ts";
import { hourlyVol } from "../../common/src/headroom-gate.ts";
import { StateStore } from "../../common/src/state-store.ts";
import { sleepWithAbort } from "../../common/src/runtime.ts";
import type { BinanceFeed } from "./binance.ts";
import type { BookFeed } from "./book-feed.ts";
import type { LagConfig } from "./config.ts";
import type { Executor } from "./executor.ts";
import { fetchTradableStrikes, type Strike } from "./markets.ts";
import {
  fetchResolvedYesPayouts,
  positionPnl,
  type Position,
  type Redeemer,
} from "./settlement.ts";
import { StrikeSignal, takerFee, type Candidate } from "./signal.ts";

const HOUR = 3_600_000;
const MARKETS_EVERY_MS = 60_000;
const SETTLE_EVERY_MS = 5 * 60_000;
const VOL_EVERY_MS = 60_000;
const BOOK_SILENCE_MS = 60_000;

interface State {
  positions: Position[];
}

interface Tracked {
  strike: Strike;
  signal: StrikeSignal;
  busy: boolean;
}

export class LagBot {
  private readonly tracked = new Map<string, Tracked>();
  private readonly store: StateStore<State>;
  private state: State = { positions: [] };
  private vol: number | null = null;
  private volAtMs = 0;
  private readonly abort = new AbortController();
  private housekeeping: Promise<void> | null = null;
  private marketsAtMs = 0;
  private settleAtMs = 0;

  constructor(
    private readonly cfg: LagConfig,
    private readonly spot: BinanceFeed,
    private readonly books: BookFeed,
    private readonly executor: Executor,
    private readonly redeemer: Redeemer | null,
    private readonly logger: Logger,
  ) {
    this.store = new StateStore<State>(cfg.stateFile);
  }

  stop(): void {
    this.abort.abort();
  }

  async run(): Promise<void> {
    this.state = await this.store.load({ positions: [] });
    await this.refreshMarkets(Date.now());
    while (!this.abort.signal.aborted) {
      const now = Date.now();
      // Housekeeping can wait on Gamma or a redeem receipt; it runs beside the
      // evaluation loop so a slow call never delays reacting to a move.
      this.housekeeping ??= this.housekeep(now).finally(() => {
        this.housekeeping = null;
      });
      for (const id of this.tracked.keys()) this.evaluate(id);
      await sleepWithAbort(500, this.abort.signal);
    }
    await this.housekeeping;
    this.spot.stop();
    this.books.stop();
  }

  private async housekeep(now: number): Promise<void> {
    try {
      if (this.tracked.size && now - this.books.lastMessageAtMs > BOOK_SILENCE_MS) {
        this.logger.warn("polymarket ws silent, reconnecting");
        this.books.lastMessageAtMs = now;
        this.books.reconnect();
      }
      if (now - this.marketsAtMs >= MARKETS_EVERY_MS) {
        this.marketsAtMs = now;
        await withTimeout(this.refreshMarkets(now), 30_000, "refresh markets");
      }
      if (now - this.settleAtMs >= SETTLE_EVERY_MS) {
        this.settleAtMs = now;
        await withTimeout(this.settle(now), 180_000, "settle");
      }
    } catch (err) {
      this.logger.warn("housekeeping failed", { err: String(err) });
    }
  }

  /** Called on every book change for a token, and twice a second for all. */
  evaluate(yesTokenId: string): void {
    const t = this.tracked.get(yesTokenId);
    if (!t || t.busy) return;
    const now = Date.now();
    const top = this.books.top(yesTokenId);
    const spot = this.spot.spot;
    if (!top || spot === null || now - this.spot.spotAtMs > this.cfg.maxSpotAgeMs) return;
    const vol = this.hourlyVol(now);
    if (vol === null) return;
    const fv = fairValue({
      spot,
      strikeUsd: t.strike.strikeUsd,
      nowMs: now,
      endMs: t.strike.endMs,
      hourlyVol: vol,
      profile: BTC_FAIR_VALUE_PARAMS.profile,
      tails: BTC_FAIR_VALUE_PARAMS.tails,
    });
    if (!fv) return;
    const candidates = t.signal.update({ nowMs: now, fairYes: fv.yes, ...top });
    for (const c of candidates) void this.act(t, c, spot, now);
  }

  private hourlyVol(now: number): number | null {
    if (now - this.volAtMs >= VOL_EVERY_MS) {
      const raw = hourlyVol(this.spot.closes, BTC_FAIR_VALUE_PARAMS.windowHours * HOUR);
      this.vol = raw === null ? null : raw * BTC_FAIR_VALUE_PARAMS.volScale;
      this.volAtMs = now;
    }
    return this.vol;
  }

  private async act(t: Tracked, c: Candidate, spot: number, now: number): Promise<void> {
    if (t.busy) return;
    const s = t.strike;
    const entry = {
      ts: new Date(now).toISOString(),
      slug: s.slug,
      side: c.side,
      price: c.price,
      sharesAtPrice: c.shares,
      fair: round(c.fair),
      edge: round(c.edge),
      basis: round(c.basis),
      spot,
      hoursLeft: round((s.endMs - now) / HOUR),
    };
    const usd = this.sizeUsd(s);
    if (usd < s.minShares * c.price || usd < 1) {
      await this.journal({ ...entry, action: "skip", reason: "risk caps", usd });
      return;
    }
    t.busy = true;
    try {
      const fill = await this.executor.buy({
        tokenId: c.side === "YES" ? s.yesTokenId : s.noTokenId,
        yesTokenId: s.yesTokenId,
        side: c.side,
        limit: c.price,
        usd,
        tickSize: s.tickSize,
        negRisk: s.negRisk,
      });
      if (!fill) {
        await this.journal({ ...entry, action: "missed", usd, latencyMs: Date.now() - now });
        return;
      }
      const avg = fill.cost / fill.shares;
      const pos: Position = {
        slug: s.slug,
        conditionId: s.conditionId,
        tokenId: c.side === "YES" ? s.yesTokenId : s.noTokenId,
        side: c.side,
        strikeUsd: s.strikeUsd,
        endMs: s.endMs,
        shares: fill.shares,
        cost: fill.cost,
        fee: fill.shares * takerFee(avg, this.cfg.signal.takerFeeRate),
        openedAtMs: now,
        fair: c.fair,
        edge: c.edge,
      };
      this.state.positions.push(pos);
      await this.store.save(this.state);
      await this.journal({
        ...entry,
        action: "filled",
        usd,
        shares: round(fill.shares),
        avgPrice: round(avg),
        orderId: fill.orderId,
        latencyMs: Date.now() - now,
      });
      this.logger.info("filled", { slug: s.slug, side: c.side, shares: fill.shares, avg });
    } catch (err) {
      await this.journal({ ...entry, action: "error", usd, err: String(err) });
      this.logger.warn("buy failed", { slug: s.slug, err: String(err) });
    } finally {
      t.busy = false;
    }
  }

  private sizeUsd(s: Strike): number {
    let open = 0;
    let onStrike = 0;
    for (const p of this.state.positions) {
      if (p.payout !== undefined) continue;
      open += p.cost;
      if (p.conditionId === s.conditionId) onStrike += p.cost;
    }
    return Math.max(
      0,
      Math.min(this.cfg.maxTradeUsd, this.cfg.maxStrikeUsd - onStrike, this.cfg.maxOpenUsd - open),
    );
  }

  private async refreshMarkets(now: number): Promise<void> {
    this.marketsAtMs = now;
    const strikes = await fetchTradableStrikes(now, this.cfg.maxHoursLeft, this.cfg.minSecondsLeft);
    const live = new Set(strikes.map((s) => s.yesTokenId));
    for (const id of this.tracked.keys()) if (!live.has(id)) this.tracked.delete(id);
    const added: string[] = [];
    for (const s of strikes) {
      const t = this.tracked.get(s.yesTokenId);
      if (t) t.strike = s;
      else {
        this.tracked.set(s.yesTokenId, { strike: s, signal: new StrikeSignal(this.cfg.signal), busy: false });
        added.push(s.yesTokenId, s.noTokenId);
      }
    }
    this.books.setTokens([...live]);
    if (added.length) {
      await this.executor.warm(added);
      this.logger.info("tracking strikes", { count: this.tracked.size, added: added.length / 2 });
    }
  }

  private async settle(now: number): Promise<void> {
    const due = this.state.positions.filter((p) => p.payout === undefined && p.endMs < now);
    if (!due.length) return;
    const conditions = [...new Set(due.map((p) => p.conditionId))];
    const yes = await fetchResolvedYesPayouts(conditions);
    let changed = false;
    for (const cid of conditions) {
      const yesPayout = yes.get(cid);
      if (yesPayout === undefined) continue;
      try {
        if (this.redeemer && !(await this.redeemer.redeem(cid as Hex))) continue;
      } catch (err) {
        this.logger.warn("redeem failed", { conditionId: cid, err: String(err) });
        continue;
      }
      for (const p of due.filter((d) => d.conditionId === cid)) {
        p.payout = p.side === "YES" ? yesPayout : 1 - yesPayout;
        p.settledAtMs = now;
        changed = true;
        await this.journal({ ts: new Date(now).toISOString(), slug: p.slug, side: p.side, action: "settled", payout: p.payout, pnl: round(positionPnl(p)!) });
      }
    }
    if (changed) await this.store.save(this.state);
  }

  private async journal(entry: Record<string, unknown>): Promise<void> {
    await appendFile(this.cfg.journalFile, JSON.stringify(entry) + "\n");
  }
}

/** Stops waiting after `ms`; the underlying call is not cancelled. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function round(x: number): number {
  return Math.round(x * 1e5) / 1e5;
}
