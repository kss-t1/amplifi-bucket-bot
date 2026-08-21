import type { BucketBotConfig } from "./config.ts";
import {
  AmplifiClient,
  ApiError,
  type Logger,
} from "../../common/src/amplifi-client.ts";
import { MarketResolver } from "../../common/src/market-resolver.ts";
import { sleepWithAbort, type Stoppable } from "../../common/src/runtime.ts";
import { StateStore } from "../../common/src/state-store.ts";
import { fetchLivePositionIds } from "../../common/src/positions.ts";
import { fetchBook, floorToTick } from "../../common/src/book.ts";
import { chooseTpDecision, DEFAULT_TP_PRICE, tpAnchorPrice } from "./tp.ts";
import {
  fetchUpcomingBtcDailyEvents,
  type BtcDailyEvent,
} from "./btc-daily.ts";
import {
  allocate,
  inferCurrentBtcStrike,
  priceToBucket,
  type AllocationTarget,
  type Bucket,
} from "./allocator.ts";
import { LendingPoolReader } from "./lending-pool.ts";
import { BtcVolGate } from "../../common/src/vol-gate.ts";
import {
  emptyStabilityState,
  isStable,
  observe,
  prune,
  type StabilityState,
} from "./stability.ts";

/** Filter `events` by max-hours-to-resolution. Events whose `endDate` is
 *  farther than `maxHours` from `now` become `null` (treated as "no-event"
 *  downstream). Pure function so the behavior is unit-testable without
 *  spinning up the bot. Returns the filtered array AND the list of skipped
 *  event slugs (for logging). When `maxHours` is undefined, returns the
 *  input untouched. */
export function applyMaxHoursToResolution(
  events: ReadonlyArray<BtcDailyEvent | null>,
  now: Date,
  maxHours: number | undefined,
): { events: (BtcDailyEvent | null)[]; skipped: string[] } {
  if (maxHours === undefined) return { events: [...events], skipped: [] };
  const cutoffMs = now.getTime() + maxHours * 60 * 60 * 1000;
  const skipped: string[] = [];
  const filtered = events.map((ev) => {
    if (!ev) return null;
    const endMs = new Date(ev.endDate).getTime();
    if (endMs <= cutoffMs) return ev;
    const hoursAway = (endMs - now.getTime()) / 3_600_000;
    skipped.push(`${ev.slug} (${hoursAway.toFixed(1)}h)`);
    return null;
  });
  return { events: filtered, skipped };
}

/**
 * Overlay live CLOB best-bid prices onto each strike's `yesPrice` / `noPrice`
 * so every downstream gate (allocator bucket selection, stability tracking,
 * stability-window check) decides off the SAME price source the maker order
 * will actually rest at.
 *
 * Background: previously the allocator read Gamma's REST snapshot
 * (`s.yesPrice`/`s.noPrice`), but maker order placement reads the live CLOB
 * book. During a fast price move those two sources disagree: the allocator
 * sees the stale snapshot bucket (stable for hours, gate passes), the order
 * posts at the live best-bid (in a different bucket), and the bot opens in
 * a bucket it isn't eligible for — bypassing the bucket filter AND the
 * stability window. Empirically observed on 2026-05-28 03:18: 3 positions
 * opened in 0.95-0.97 within 12 min of the bucket transition (bot3 isn't
 * even configured for 0.95-0.97), ~$18 in liquidations.
 *
 * NO FALLBACK: if either side's live best-bid is unavailable (CLOB fetch
 * threw, or the book has no bid), the strike is dropped from the event so
 * no downstream gate operates on a stale price. Bots refuse to open on a
 * strike whose live price they cannot read.
 *
 * Pure function — the side-effecting fetch is injected as `resolveBidPrice`.
 */
export async function resolveLiveStrikePrices(
  events: ReadonlyArray<BtcDailyEvent | null>,
  resolveBidPrice: (tokenId: string) => Promise<number | null>,
): Promise<{ events: (BtcDailyEvent | null)[]; droppedStrikes: number }> {
  let dropped = 0;
  const resolved = await Promise.all(
    events.map(async (ev) => {
      if (!ev) return null;
      const safeResolve = async (id: string): Promise<number | null> => {
        try {
          return await resolveBidPrice(id);
        } catch {
          return null;
        }
      };
      const strikes = await Promise.all(
        ev.strikes.map(async (s) => {
          const [yesBid, noBid] = await Promise.all([
            safeResolve(s.yesTokenId),
            safeResolve(s.noTokenId),
          ]);
          if (yesBid == null || noBid == null) {
            dropped++;
            return null;
          }
          return { ...s, yesPrice: yesBid, noPrice: noBid };
        }),
      );
      return {
        ...ev,
        strikes: strikes.filter((s): s is NonNullable<typeof s> => s !== null),
      };
    }),
  );
  return { events: resolved, droppedStrikes: dropped };
}

/** A bot-owned (event, strike, side) slot. Always carries the open order
 *  it placed first; once that order fills, `positionId` is populated and the
 *  slot is held until resolution. Orders that get canceled or fail are
 *  cleared so the next poll cycle redeploys their budget. */
interface OpenSlot {
  /** Compound key: Gamma event slug + market slug + outcome. Identifies a
   *  specific (date, strike, side) the bot opened. Survives restarts. */
  key: string;
  eventSlug: string;
  marketSlug: string;
  conditionId: string;
  /** Canonical YES tokenId from Amplifi's market record. The backend's
   *  open-position contract requires this even for NO bets — `outcome`
   *  picks the side. */
  tokenId: string;
  outcome: "YES" | "NO";
  bucket: string;
  leverage: number;
  collateralUsd: number;
  /** Maker limit price (best-bid at place time, rounded down to tick). */
  limitPrice: number;
  /** Tick size we used; needed for reprice escalation. */
  tickSize: number;
  /** Order id on Amplifi (the gateway record); null only in dry-run. */
  orderId: number | null;
  /** Position id once the order fills (status becomes FILLED). Null while
   *  the order is still RESTING / PENDING / PARTIALLY_FILLED. */
  positionId: number | null;
  /** ms epoch of the most recent placeLimitOrder for this slot. Used by
   *  the reprice clock — see `maker.maxRestingAgeMs`. */
  lastPlacedAt: number;
  /** How many times we cancel+replaced this slot's order. Capped at
   *  `maker.maxRepricesPerSlot`. */
  repriceCount: number;
  /** Average fill price captured when the order transitioned to FILLED.
   *  Drives the take-profit price calculation. Null until fill. */
  fillPrice: number | null;
  /** Take-profit price actively registered on the position. Null while the
   *  order is still RESTING or while the position is waiting for its
   *  TP-set call to succeed. */
  tpPrice: number | null;
  /** True iff the ROE/leverage combo yields a TP price outside the
   *  CLOB-valid range (e.g. fillPrice already so close to 1 that one
   *  tick above doesn't move it). Set once and not retried — the slot
   *  rides to resolution like the legacy (no-TP) flow. Separated from
   *  `tpPrice` so the latter only ever holds a price the backend
   *  acknowledged. */
  tpSkipped: boolean;
  /** Once true, ensureTakeProfits prices this slot's TP at the fixed
   *  `DEFAULT_TP_PRICE` instead of the ROE target. Set after the book bids
   *  past the ROE target (setTakeProfit rejected with "must be above current
   *  best bid") — the higher fixed price rests above the bid where the ROE
   *  price can't. */
  tpForceFixed: boolean;
  /** Consecutive setTakeProfit failures since the last success. Drives
   *  exponential backoff so a persistent 400 (e.g. tp < bestBid because
   *  the side moved against us) doesn't hammer the endpoint every poll. */
  tpFailureCount: number;
  /** ms epoch of the most recent setTakeProfit failure. Cleared on
   *  success. */
  tpFailureAt: number | null;
  /** SERVER-side stop-loss price acknowledged by the backend. Null until
   *  the setStopLoss call succeeds; the backend owns the firing from then
   *  on. Optional: state files predating server SLs lack the field. */
  slPrice?: number | null;
  /** True once a slot's stop price can't clear the backend's validation
   *  even after the bump-above-liquidation retry — the slot rides with
   *  liquidation as its only downside protection. */
  slSkipped?: boolean;
  /** Consecutive setStopLoss failures since the last success (backoff). */
  slFailureCount?: number;
  /** ms epoch of the most recent setStopLoss failure. */
  slFailureAt?: number | null;
}

interface PersistedState {
  openByKey: Record<string, OpenSlot>;
  /** Reprice counter per slotKey. Survives the delete-on-cancel of
   *  `openByKey[key]` so the `MAKER_MAX_REPRICES_PER_SLOT` cap can
   *  actually enforce — incrementing `slot.repriceCount` immediately
   *  before `delete openByKey[key]` would orphan the bump in memory and
   *  the next `tryPlaceMakerOrder` would re-init the slot at 0. Cleared
   *  on FILLED (slot becomes a position) or terminal CANCELED / FAILED. */
  repriceCounts: Record<string, number>;
  /** Per-(slug, outcome) bucket-stability tracking. Persisted so a quick
   *  restart doesn't reset the 15-min clock; long pauses are caught by
   *  the `maxGapMs` check in `isStable`. */
  stability: StabilityState;
  startedAt: number;
  /** ms epoch of this bot's most recent observed liquidation. Drives the
   *  optional re-entry cooldown. null = none seen. */
  lastLiquidatedAt: number | null;
}

const EMPTY_STATE = (): PersistedState => ({
  openByKey: {},
  repriceCounts: {},
  stability: emptyStabilityState(),
  startedAt: Date.now(),
  lastLiquidatedAt: null,
});

/** Exponential-backoff window for failed setTakeProfit calls. After
 *  attempt N the next attempt is gated until `BASE × 2^(N-1)` has
 *  elapsed since the last failure, capped at `MAX`. After
 *  `TP_MAX_ATTEMPTS` consecutive failures we stop trying and let the
 *  position ride to resolution like the legacy (no-TP) flow. Mirrors
 *  the harvester's bot tuning. */
const TP_BACKOFF_BASE_MS = 30_000;
const TP_BACKOFF_MAX_MS = 600_000;
const TP_MAX_ATTEMPTS = 10;

const slotKey = (
  eventSlug: string,
  marketSlug: string,
  outcome: "YES" | "NO",
) => `${eventSlug}|${marketSlug}|${outcome}`;

export class BucketBot implements Stoppable {
  private state: PersistedState = EMPTY_STATE();
  private aborter = new AbortController();
  private store: StateStore<PersistedState>;
  /** Synthetic dry-run order id sequence — never collides with real ids. */
  private dryRunOrderSeq = -1_000_000;
  /** Synthetic dry-run position id sequence (taker mode dry-runs). */
  private dryRunPositionSeq = -2_000_000;
  private poolReader: LendingPoolReader | null;
  private volGate: BtcVolGate | null;
  /** slotKeys already recorded as gate-blocked in the current block episode
   *  (cleared on any calm cycle), so each prevented open is logged once. */
  private blockLoggedKeys = new Set<string>();
  /** Consecutive stop-loss breaches per slot key (drift stop debounce —
   *  fire only on the 2nd consecutive breaching poll so a one-tick wick
   *  can't convert a routine dip into a realized loss). In-memory on
   *  purpose: a restart resets the count and simply re-observes. */

  constructor(
    private readonly cfg: BucketBotConfig,
    private readonly client: AmplifiClient,
    private readonly resolver: MarketResolver,
    private readonly logger: Logger,
  ) {
    this.store = new StateStore<PersistedState>(cfg.stateFile);
    this.poolReader =
      cfg.lendingPoolAddress && cfg.minRoiAfterInterestPct !== undefined
        ? new LendingPoolReader(
            {
              poolAddress: cfg.lendingPoolAddress,
              rpcUrl: cfg.polygonRpcUrl,
            },
            logger,
          )
        : null;
    this.volGate = cfg.volGateEnabled
      ? new BtcVolGate(cfg.volRules, cfg.btcVolPollMs, logger)
      : null;
  }

  stop(): void {
    this.aborter.abort();
  }

  async run(): Promise<void> {
    await this.loadState();
    await this.bootstrap();
    if (this.volGate) {
      await this.volGate.seed();
      this.logger.info("vol gate enabled", {
        rules: this.volGate.describeRules(),
      });
    }
    if (this.cfg.stopLossEnabled) {
      this.logger.info("server stop-loss enabled", {
        marginFraction: this.cfg.stopLossMarginFraction,
        dryRun: this.cfg.dryRun,
      });
    }

    while (!this.aborter.signal.aborted) {
      try {
        await this.pollOnce();
      } catch (err) {
        this.logger.error("poll cycle failed", err);
      }
      await sleepWithAbort(this.cfg.pollIntervalMs, this.aborter.signal);
    }
  }

  private async loadState(): Promise<void> {
    this.state = await this.store.load(EMPTY_STATE());
    // Defensive init for fields added after the first ship of this schema.
    // `StateStore.load` returns the parsed JSON as-is (no shape merge), so
    // a state file written before `repriceCounts` existed would leave it
    // `undefined` and the first `state.repriceCounts[key]` access in
    // `tryPlaceMakerOrder` / `maybeReprice` would throw. Cheaper than
    // relying on the operator to wipe state on every schema bump.
    this.state.repriceCounts ??= {};
    this.state.stability ??= emptyStabilityState();
    this.state.stability.byKey ??= {};
    this.state.lastLiquidatedAt ??= null;
    // Backfill TP fields on slots loaded from a pre-TP state file so the
    // backoff math doesn't trip on `undefined` arithmetic.
    for (const slot of Object.values(this.state.openByKey)) {
      slot.fillPrice ??= null;
      slot.tpPrice ??= null;
      slot.tpSkipped ??= false;
      slot.tpForceFixed ??= false;
      slot.tpFailureCount ??= 0;
      slot.tpFailureAt ??= null;
    }
    this.logger.info("loaded state", {
      openSlots: Object.keys(this.state.openByKey).length,
    });
  }

  private async bootstrap(): Promise<void> {
    this.logger.info("config", {
      apiBase: this.cfg.apiBase,
      bot: this.cfg.botAddress,
      totalCapitalUsd: this.cfg.totalCapitalUsd,
      days: this.cfg.days,
      dayWeights: this.cfg.dayWeights,
      buckets: [...this.cfg.allowedBuckets],
      leverage: this.cfg.leveragePerBucket,
      restricted: this.cfg.restricted,
      dryRun: this.cfg.dryRun,
      pollMs: this.cfg.pollIntervalMs,
      makerMaxRestingAgeSec: this.cfg.maker.maxRestingAgeMs / 1000,
      makerMaxRepricesPerSlot: this.cfg.maker.maxRepricesPerSlot,
      tpRoePct: this.cfg.tpRoePct ?? `unset (fixed TP @ ${DEFAULT_TP_PRICE})`,
      maxHoursToResolution:
        this.cfg.maxHoursToResolution ?? "unset (no time-to-resolution filter)",
      maxHoursPerBucket: this.cfg.maxHoursPerBucket,
      minHoursPerBucket: this.cfg.minHoursPerBucket,
      maxEntryPrice: this.cfg.maxEntryPrice ?? "unset (no entry-price ceiling)",
      minRoiAfterInterestPct:
        this.cfg.minRoiAfterInterestPct ?? "unset (no ROI gate)",
      lendingPoolAddress:
        this.cfg.lendingPoolAddress ?? "unset (ROI gate disabled)",
      bucketStabilityWindowMin:
        this.cfg.bucketStabilityWindowMin ?? "unset (no stability gate)",
      maxPositionCollateralUsd:
        this.cfg.maxPositionCollateralUsd ?? "unset (no per-position cap)",
      orderMode: this.cfg.orderMode,
    });

    if (this.cfg.dryRun) {
      this.logger.info("DRY-RUN: skipping wallet/balance setup");
      return;
    }

    await this.client.ensureWallet();
    const bal = await this.client.getBalance();
    const available = parseFloat(bal.availableBalanceFormatted ?? "0");
    const equity = parseFloat(bal.equityFormatted ?? "0");
    this.logger.info("amplifi balance", {
      availableUsd: available,
      equityUsd: equity,
    });

    // No auto-deposit. The operator funds the bot's Amplifi balance up
    // front; the bot operates with whatever capital is on Amplifi when
    // it starts (allocator already caps deployment at `TOTAL_CAPITAL_USD`).
    // Auto top-up was previously triggered when `available < totalCapital`,
    // but `available` drops every time a slot's collateral gets locked in a
    // RESTING / OPEN position — so a restart with even one slot in flight
    // would mistake locked margin for missing capital and try to redeposit
    // (and crash if the EOA has no USDC.e left).
  }

  private async pollOnce(): Promise<void> {
    const now = new Date();
    if (this.volGate) await this.volGate.poll();
    this.logger.info("fetching gamma events", {
      seriesId: this.cfg.btcDailySeriesId,
      days: this.cfg.days,
    });

    let events: (BtcDailyEvent | null)[];
    try {
      events = await fetchUpcomingBtcDailyEvents(now, this.cfg.days, {
        seriesId: this.cfg.btcDailySeriesId,
      });
    } catch (err) {
      this.logger.warn("gamma series fetch failed", err);
      events = Array.from({ length: this.cfg.days }, () => null);
    }

    // Apply MAX_HOURS_TO_RESOLUTION filter: events whose end_date is
    // beyond the threshold become null. Liquidation-rate analysis showed
    // markets resolving 36-72h+ from now have 33-67% liq rates vs ~10%
    // in the <24h window, so those days idle instead of trading.
    // Treated as "no-event" downstream — budget for that day stays unspent.
    const filterResult = applyMaxHoursToResolution(
      events,
      now,
      this.cfg.maxHoursToResolution,
    );
    events = filterResult.events;
    if (filterResult.skipped.length > 0) {
      this.logger.info("max-hours-to-resolution filter", {
        cutoffHours: this.cfg.maxHoursToResolution,
        skippedEvents: filterResult.skipped,
      });
    }

    // Overlay live CLOB best-bid onto each strike. Allocator + observeStability
    // + stability-window gate all run off this single live price source so the
    // bucket they evaluate is the bucket the order will actually rest in.
    // Strikes whose live bid we cannot read are dropped — NO fallback to
    // Gamma's snapshot. See `resolveLiveStrikePrices` doc.
    const tickFallback = this.cfg.maker.defaultTickSize;
    const liveResult = await resolveLiveStrikePrices(
      events,
      async (tokenId) => {
        try {
          const book = await fetchBook(tokenId, tickFallback);
          return book.bestBid;
        } catch {
          return null;
        }
      },
    );
    events = liveResult.events;
    if (liveResult.droppedStrikes > 0) {
      this.logger.info("live-price overlay dropped strikes", {
        droppedStrikes: liveResult.droppedStrikes,
      });
    }

    const atmStrikes = events.map((e) => (e ? inferCurrentBtcStrike(e) : null));

    // Refresh order/position state from Amplifi FIRST so a downstream
    // balance-fetch failure doesn't strand resting orders mid-cycle (skipped
    // reconcile means fills go undetected, stale best-bids never reprice,
    // and resolved slots aren't cleared until balance comes back). Drives
    // all three transitions: RESTING→FILLED, RESTING→reprice, FILLED→resolved.
    await this.reconcileState();

    // Scale per-day budgets off LIVE equity rather than the configured
    // `TOTAL_CAPITAL_USD` (the initial deposit). When the bot is up on the
    // session, qualifying slots get sized larger; when it's down, smaller —
    // so a bad streak doesn't keep risking the same absolute notional on a
    // shrinking account. `equityFormatted` is portfolio value minus on-chain
    // debt; existing open slots stay at the size they were placed at and
    // only newly-deployed slots see the rescaled budget.
    //
    // Dry-run has no real balance to fetch and falls back to the configured
    // capital so the planning log stays meaningful. Live-mode fetch failure
    // skips ONLY the new-order placement (return below) — reconcile already
    // ran, so fills / reprices / resolutions are still processed and saved.
    let capitalUsd: number;
    if (this.cfg.dryRun) {
      capitalUsd = this.cfg.totalCapitalUsd;
    } else {
      try {
        const bal = await this.client.getBalance();
        const equity = parseFloat(bal.equityFormatted ?? "0");
        if (!Number.isFinite(equity)) {
          throw new Error(
            `getBalance returned non-finite equity: ${bal.equityFormatted}`,
          );
        }
        capitalUsd = Math.max(equity, 0);
      } catch (err) {
        this.logger.warn(
          "balance fetch failed; skipping new placements (reconcile already ran)",
          err,
        );
        await this.store.save(this.state);
        return;
      }
    }

    this.logger.info("allocator capital basis", {
      capitalUsd,
      source: this.cfg.dryRun ? "config (dry-run)" : "live-equity",
    });

    // Fetch live APR from the lending pool if the ROI gate is engaged.
    // Failure fails-closed: skip new placements this cycle so we don't
    // open in the deep-ITM band without knowing the cost of carry. The
    // reader caches for 5 min so the cost of this call is amortized.
    let aprDecimal: number | undefined;
    if (this.poolReader && this.cfg.minRoiAfterInterestPct !== undefined) {
      try {
        aprDecimal = await this.poolReader.getAprDecimal();
      } catch (err) {
        this.logger.warn(
          "lending-pool borrowRate fetch failed; skipping new placements this cycle",
          err,
        );
        await this.store.save(this.state);
        return;
      }
    }

    // Record current bucket observation for every (event, strike, side)
    // we MIGHT trade. The stability gate downstream reads this buffer.
    // Done before allocator so dropped-by-filters strikes still update
    // the buffer (a market that just crossed into 0.99+ for the first
    // time still needs its sinceMs anchored now, not on the next poll).
    this.observeStability(events, atmStrikes, now);

    const { targets, daySummaries, droppedMarkets } = allocate(
      events,
      atmStrikes,
      {
        totalCapitalUsd: capitalUsd,
        restricted: this.cfg.restricted,
        leveragePerBucket: this.cfg.leveragePerBucket,
        allowedBuckets: this.cfg.allowedBuckets,
        dayWeights: this.cfg.dayWeights,
        now,
        maxHoursPerBucket: this.cfg.maxHoursPerBucket,
        minHoursPerBucket: this.cfg.minHoursPerBucket,
        maxEntryPrice: this.cfg.maxEntryPrice,
        roiGate:
          aprDecimal !== undefined &&
          this.cfg.minRoiAfterInterestPct !== undefined
            ? {
                aprDecimal,
                minRoi: this.cfg.minRoiAfterInterestPct / 100,
                now,
              }
            : undefined,
        maxPositionCollateralUsd: this.cfg.maxPositionCollateralUsd,
      },
    );

    for (const d of daySummaries) {
      this.logger.info("day plan", d);
    }
    if (droppedMarkets.length > 0) {
      this.logger.info("filtered strikes", { droppedMarkets });
    }

    // Open targets we don't already cover. Don't close existing positions:
    // the user spec is "rebalance daily as day-1 markets resolve", so we
    // hold every filled slot to resolution and only redeploy after the
    // natural resolution event frees that capital.
    // Gate on opening NEW positions (vol gate + re-entry cooldown). A
    // directional vol rule blocks only the side the BTC move hurts, so
    // evaluate once per side; existing positions, TP, and closes are
    // unaffected.
    const blockBySide: Record<"YES" | "NO", Record<string, unknown> | null> = {
      YES: this.shouldBlockOpens(now.getTime(), "YES"),
      NO: this.shouldBlockOpens(now.getTime(), "NO"),
    };
    const anyBlock = blockBySide.YES ?? blockBySide.NO;
    if (anyBlock && targets.length > 0)
      this.logger.info("skip opens — gate", {
        YES: blockBySide.YES,
        NO: blockBySide.NO,
      });
    // Reset the per-episode dedup per SIDE, so a side that has gone calm
    // re-records its would-be opens on its next episode even while the other
    // side stays blocked. Slot keys end in `|YES` / `|NO`.
    for (const side of ["YES", "NO"] as const) {
      if (blockBySide[side]) continue;
      for (const key of this.blockLoggedKeys)
        if (key.endsWith(`|${side}`)) this.blockLoggedKeys.delete(key);
    }
    // Blocking new opens is not enough: a resting maker BUY placed in a calm
    // cycle still sits in the book and FILLS if the spike sweeps through it,
    // re-arming the very directional exposure the gate exists to prevent
    // (observed live on vm018 2026-06-29 — calm-placed 0.99+ NO orders filled
    // mid-spike while the gate correctly blocked fresh opens). So whenever
    // opens are gated, also CANCEL the bot's own still-resting, zero-fill open
    // orders. Filled slots (positionId set) keep riding to resolution untouched.
    if (anyBlock) await this.cancelRestingOpensOnBlock(blockBySide);

    for (const t of targets) {
      const key = slotKey(t.eventSlug, t.marketSlug, t.outcome);
      if (this.state.openByKey[key]) continue;
      const gated = blockBySide[t.outcome];
      if (gated) {
        this.recordBlockedOpen(key, t, gated, now.getTime());
        continue;
      }
      if (!this.passesStabilityGate(t, now)) continue;
      if (this.cfg.orderMode === "taker") {
        await this.tryOpenTaker(key, t);
      } else {
        await this.tryPlaceMakerOrder(key, t);
      }
    }

    // Prune stability entries we haven't observed in a while (markets
    // that have rolled out of the bot's day window). Keeps the file size
    // bounded across long-running production deployments.
    prune(this.state.stability, now.getTime(), 24 * 60 * 60 * 1000);

    await this.store.save(this.state);
  }

  /** Per-poll cap on the observation gap that still counts as a continuous
   *  stability streak. `observe` resets the streak when the prior
   *  `lastSeenMs` is older than this; `isStable` uses the same value as
   *  defense-in-depth. Tolerates a single missed cycle without throwing
   *  away the streak, but invalidates long pauses / restarts. */
  private maxStabilityGapMs(): number {
    return Math.max(this.cfg.pollIntervalMs * 3, 90_000);
  }

  /** Anchor a stability sample for every (slug, outcome) the bot would
   *  consider this poll. Records the canonical bucket (or `null` when the
   *  qualifying-side price sits outside any tracked bucket). */
  private observeStability(
    events: ReadonlyArray<BtcDailyEvent | null>,
    atmStrikes: ReadonlyArray<number | null>,
    now: Date,
  ): void {
    const nowMs = now.getTime();
    const maxGapMs = this.maxStabilityGapMs();
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const atm = atmStrikes[i];
      if (!ev || atm == null) continue;
      for (const s of ev.strikes) {
        if (s.closed) continue;
        if (s.strikeUsd === atm) continue;
        const isBelow = s.strikeUsd < atm;
        const outcome: "YES" | "NO" = isBelow ? "YES" : "NO";
        const qPrice = isBelow ? s.yesPrice : s.noPrice;
        const bucket: Bucket | null = priceToBucket(qPrice);
        observe(this.state.stability, s.slug, outcome, bucket, nowMs, maxGapMs);
      }
    }
  }

  /** True when the stability gate is disabled OR the bot has observed this
   *  target's bucket continuously for the configured window. */
  private passesStabilityGate(t: AllocationTarget, now: Date): boolean {
    const windowMin = this.cfg.bucketStabilityWindowMin;
    if (windowMin === undefined) return true;
    const windowMs = windowMin * 60 * 1000;
    const stable = isStable(
      this.state.stability,
      t.marketSlug,
      t.outcome,
      t.bucket,
      windowMs,
      this.maxStabilityGapMs(),
      now.getTime(),
    );
    if (!stable) {
      const entry =
        this.state.stability.byKey[`${t.marketSlug}|${t.outcome}`] ?? null;
      this.logger.info("skip: bucket-stability window not yet satisfied", {
        marketSlug: t.marketSlug,
        outcome: t.outcome,
        targetBucket: t.bucket,
        observedBucket: entry?.bucket ?? "none",
        sinceMs: entry?.sinceMs ?? null,
        windowMin,
      });
    }
    return stable;
  }

  /**
   * Fleet-wide gate on opening NEW positions. Returns a reason object when
   * opens should be blocked this cycle, else null. Two independent arms:
   *   - vol gate: BTC move over any configured window exceeds its threshold
   *     (a sharp spike or a slow grind). A directional rule only blocks the
   *     side the move hurts, so `side` must be passed to get that narrowing;
   *   - re-entry cooldown: this bot was liquidated within the last
   *     `reentryCooldownMs` (shape-independent — don't re-arm into the storm).
   * Both are off unless configured. Existing positions / TP / closes are never
   * affected — this only suppresses new opens.
   */
  private shouldBlockOpens(
    nowMs: number,
    side?: "YES" | "NO",
  ): Record<string, unknown> | null {
    if (this.volGate) {
      const d = this.volGate.evaluate(side);
      if (d.block)
        return { gate: "vol", side, breaches: d.breaches, moves: d.moves };
    }
    if (this.cfg.reentryCooldownMs && this.state.lastLiquidatedAt !== null) {
      const sinceMs = nowMs - this.state.lastLiquidatedAt;
      if (sinceMs >= 0 && sinceMs < this.cfg.reentryCooldownMs)
        return {
          gate: "reentry-cooldown",
          sinceMs,
          cooldownMs: this.cfg.reentryCooldownMs,
        };
    }
    return null;
  }

  /**
   * Record a gate-PREVENTED would-be open, once per block episode, with enough
   * to reconstruct the counterfactual P&L offline (tokenId + entry + leverage +
   * collateral + ts → resolution + post-block price path → would-be
   * liquidation / resolution). This lets us report the gate's real value
   * WITHOUT a live A/B: grep `vol_gate_blocked_open` from the bot log, then for
   * each record look up the token's resolution + post-`ts` price path and
   * replay the would-be position (liq at `entryPriceMid × (1 − 0.7/leverage)`,
   * else $1/$0 at resolution) — the same model the bucket backtest uses.
   * Deduped via `blockLoggedKeys` (cleared per side on that side's calm
   * cycles) so a slot blocked
   * for 60 cycles counts as one prevented open, captured at the price it WOULD
   * have entered.
   */
  private recordBlockedOpen(
    key: string,
    t: AllocationTarget,
    gate: Record<string, unknown>,
    nowMs: number,
  ): void {
    if (this.blockLoggedKeys.has(key)) return;
    this.blockLoggedKeys.add(key);
    this.logger.info("vol_gate_blocked_open", {
      ts: nowMs,
      eventSlug: t.eventSlug,
      marketSlug: t.marketSlug,
      conditionId: t.conditionId,
      tokenId: t.tokenId,
      outcome: t.outcome,
      bucket: t.bucket,
      leverage: t.leverage,
      entryPriceMid: t.entryPriceMid,
      strikeUsd: t.strikeUsd,
      collateralUsd: t.collateralUsd,
      gate,
    });
  }

  /**
   * While opens are gated, cancel the bot's own still-RESTING, zero-fill open
   * orders so the spike can't sweep them into a fresh directional position.
   * Runs every blocked cycle (idempotent: filled / non-resting slots are
   * skipped). Mirrors the reprice pass's safety EXACTLY — the only difference
   * is a clean cancel FREES the slot WITHOUT re-placing (the gate is blocking),
   * so the allocator re-opens naturally once calm returns.
   *
   *   - Only touches slots with an outstanding `orderId` and NO `positionId`
   *     (a resting open order). A filled slot is a live position — keep it
   *     riding to resolution, untouched (the user spec: "keep these riding").
   *   - Re-checks live status before canceling and SKIPS any order with fills
   *     (`PARTIALLY_FILLED` or `sharesFilled > 0`): canceling a partially-filled
   *     leveraged order makes the backend treat the unfilled fraction as FINAL
   *     loan settlement → `BadDebtRealized` on the filled fraction. Same hazard
   *     the reprice pass documents. Capture the positionId + keep the slot.
   *   - After a successful cancel, re-polls: if the cancel landed AFTER a race
   *     fill, keep the slot (attach positionId) so the allocator can't
   *     double-open the same (event, market, outcome).
   *
   * Take-profit SELLs live on filled positions (separate slots with a
   * positionId), so the `positionId == null` filter never touches them.
   */
  private async cancelRestingOpensOnBlock(
    blockBySide: Record<"YES" | "NO", Record<string, unknown> | null>,
  ): Promise<void> {
    if (this.cfg.dryRun) return;
    for (const key of Object.keys(this.state.openByKey)) {
      const slot = this.state.openByKey[key];
      if (!slot || slot.orderId == null || slot.positionId != null) continue;
      // slotKey is `event|market|outcome` — keep resting orders on a side the
      // gate is not blocking.
      const side = key.split("|")[2] === "YES" ? "YES" : "NO";
      const gate = blockBySide[side];
      if (!gate) continue;

      let live;
      try {
        live = await this.client.getOrder(slot.orderId);
      } catch (err) {
        this.logger.warn("vol-gate cancel: getOrder failed, skipping", {
          key,
          orderId: slot.orderId,
          err: err instanceof ApiError ? err.body.slice(0, 200) : err,
        });
        continue;
      }

      const filled = live.sharesFilled ? Number(live.sharesFilled) : 0;
      if (
        live.status === "PARTIALLY_FILLED" ||
        (Number.isFinite(filled) && filled > 0)
      ) {
        // Already (partly) filled — it's a real position now. Attach the
        // positionId and keep the slot riding; never cancel (would book bad
        // debt on the filled fraction).
        if (live.positionId != null) {
          slot.positionId = live.positionId;
          const fillPrice = live.avgFillPrice
            ? Number(live.avgFillPrice)
            : slot.limitPrice;
          if (Number.isFinite(fillPrice) && fillPrice > 0)
            slot.fillPrice = fillPrice;
        }
        this.logger.info("vol-gate cancel: skip — order has fills, kept", {
          key,
          orderId: slot.orderId,
          status: live.status,
          positionId: live.positionId,
          sharesFilled: live.sharesFilled,
        });
        continue;
      }
      if (live.status !== "RESTING") continue; // PENDING/CANCELED/etc → reconcile

      this.logger.info("vol_gate_cancel_resting", {
        key,
        orderId: slot.orderId,
        limitPrice: slot.limitPrice,
        gate,
      });
      try {
        await this.client.cancelOrder(slot.orderId);
        // Race window: a match sitting ahead of the cancel can fill the order
        // between the pre-cancel RESTING read and the cancel landing. Re-poll;
        // if it filled, keep the slot (attach positionId) so the allocator
        // can't re-place a duplicate. Mirrors the reprice race guard.
        let postFilled = 0;
        let postPositionId: number | null = null;
        let postOk = false;
        try {
          const post = await this.client.getOrder(slot.orderId);
          postFilled = post.sharesFilled ? Number(post.sharesFilled) : 0;
          postPositionId = post.positionId;
          postOk = true;
        } catch (err) {
          this.logger.warn(
            "vol-gate cancel: post-cancel getOrder failed — keeping slot (Pass 1 re-checks)",
            {
              orderId: slot.orderId,
              err: err instanceof ApiError ? err.body.slice(0, 200) : err,
            },
          );
        }
        if (!postOk) continue;
        if (postFilled > 0) {
          if (postPositionId != null) {
            slot.positionId = postPositionId;
            slot.fillPrice ??= slot.limitPrice;
          }
          this.logger.info(
            "vol-gate cancel landed AFTER fill — keeping slot to avoid double-open",
            { key, orderId: slot.orderId, sharesFilled: postFilled },
          );
          continue;
        }
        // Clean cancel, zero fills — free the slot. Do NOT re-place: opens are
        // gated. The allocator re-opens this (event, market, outcome) on its
        // own once the gate clears.
        delete this.state.openByKey[key];
        this.logger.info("vol_gate_cancel_resting done — slot freed", {
          key,
          orderId: slot.orderId,
        });
      } catch (err) {
        this.logger.warn(
          "vol-gate cancelOrder failed; will retry next blocked tick",
          {
            orderId: slot.orderId,
            err: err instanceof ApiError ? err.body.slice(0, 200) : err,
          },
        );
      }
    }
  }

  /**
   * Four sub-passes:
   *   1. For each slot with an outstanding orderId (no positionId yet),
   *      refresh the order status. FILLED → record positionId. CANCELED /
   *      FAILED → drop slot (next poll redeploys budget).
   *   2. For each slot still RESTING after `maxRestingAgeMs`, check if the
   *      book's best-bid moved up by ≥1 tick. If so, cancel and let the
   *      next poll re-place at the new best-bid. Capped at
   *      `maxRepricesPerSlot` retries.
   *   3. Register a take-profit limit-sell on every filled slot that
   *      doesn't have one yet — ROE-priced when `cfg.tpRoePct` is set,
   *      otherwise at the fixed `DEFAULT_TP_PRICE`. Retry on failure
   *      under exponential backoff up to `TP_MAX_ATTEMPTS`.
   *   4. For each slot whose order has already filled (has positionId), drop
   *      it if Amplifi no longer reports the position as live — that means
   *      the position closed (TP fired, market resolved, or operator
   *      intervention) and the capital is freed for the next allocator pass.
   */
  private async reconcileState(): Promise<void> {
    const keys = Object.keys(this.state.openByKey);
    if (keys.length === 0) return;
    if (this.cfg.dryRun) {
      // Dry-run: synthetic orderIds, no real state to reconcile. Treat all
      // slots as perpetually RESTING so the dry-run log shows steady-state
      // behavior.
      return;
    }

    // Pass 1: refresh outstanding orders.
    for (const key of keys) {
      const slot = this.state.openByKey[key];
      if (!slot || slot.positionId != null || slot.orderId == null) continue;
      try {
        const order = await this.client.getOrder(slot.orderId);
        if (order.status === "FILLED" && order.positionId != null) {
          slot.positionId = order.positionId;
          const fillPrice = order.avgFillPrice
            ? Number(order.avgFillPrice)
            : slot.limitPrice;
          if (Number.isFinite(fillPrice) && fillPrice > 0) {
            slot.fillPrice = fillPrice;
          }
          // Slot reached a terminal good state — drop the reprice counter
          // so a future redeployment of the same key starts fresh.
          delete this.state.repriceCounts[key];
          this.logger.info("FILLED", {
            key,
            orderId: slot.orderId,
            positionId: slot.positionId,
            limitPrice: slot.limitPrice,
            avgFillPrice: order.avgFillPrice,
            sharesFilled: order.sharesFilled,
          });
        } else if (order.status === "CANCELED" || order.status === "FAILED") {
          // Same reprice-race concern as in `maybeReprice` (PR #1130): a
          // CANCELED order can carry partial fills that the backend has
          // already materialized (or will shortly) into a position. Dropping
          // the slot here lets the allocator's next pass re-place a fresh
          // full-collateral order against the SAME (event, market, outcome) —
          // exactly the double-open the reprice fix prevents.
          //
          // If the canceled order has any fills, keep the slot pointed at
          // the order: subsequent ticks of this loop will pick up the
          // materialized positionId via `order.positionId` once the backend's
          // OrderFillMonitor catches up. FAILED orders never fill, so the
          // drop is safe there.
          const sharesFilled = order.sharesFilled
            ? Number(order.sharesFilled)
            : 0;
          if (order.status === "CANCELED" && sharesFilled > 0) {
            if (order.positionId != null) slot.positionId = order.positionId;
            this.logger.info(
              "canceled order has partial/full fill — keeping slot to attach positionId",
              {
                key,
                orderId: slot.orderId,
                sharesFilled,
                positionId: order.positionId,
              },
            );
            continue;
          }
          this.logger.info(
            `order ${order.status.toLowerCase()} — dropping slot`,
            {
              key,
              orderId: slot.orderId,
              errorMessage: order.errorMessage,
            },
          );
          delete this.state.openByKey[key];
          // Terminal failure path: clear counter too. A future redeploy of
          // the same key (e.g. next allocator pass) gets a fresh reprice
          // budget rather than inheriting the count from an unrelated
          // failure cause (account ban, market closed, etc.).
          delete this.state.repriceCounts[key];
        }
        // else: still PENDING / RESTING / PARTIALLY_FILLED / PENDING_CANCEL —
        // leave alone. PENDING_CANCEL means a prior cancelOrder request
        // succeeded on the CLOB side but the proportional loan repay didn't
        // confirm in time (Cloudflare 524, RPC blip). The backend's
        // OrphanedLoanSweeper will resume and transition to CANCELED;
        // dropping the slot here would let the allocator double-book the
        // bucket while the loan is still ISSUED.
      } catch (err) {
        this.logger.warn("getOrder failed; will retry next cycle", {
          orderId: slot.orderId,
          err: err instanceof ApiError ? err.body.slice(0, 200) : err,
        });
      }
    }

    // Pass 2: reprice stale RESTING orders whose best-bid drifted.
    await this.maybeReprice();

    // Pass 3: ensure every filled slot has its take-profit registered.
    // ROE-based TP when `tpRoePct` is set; otherwise a fixed TP at
    // `DEFAULT_TP_PRICE` so capital is freed before resolution instead of
    // riding every slot to expiry. Same pass also handles retry-on-failure
    // (slots whose previous setTakeProfit 400'd) under exponential backoff.
    // dry-run is implicitly excluded — no slot has a positionId in
    // dry-run, and ensureTakeProfits only touches slots with positionId.
    await this.ensureTakeProfits();

    // Pass 3b: ensure every filled leveraged slot has its SERVER-side
    // stop-loss registered (the backend monitor owns the firing).
    await this.ensureStopLosses();

    // Pass 4: drop slots whose filled position has resolved on-chain.
    const slotsWithPosition = Object.values(this.state.openByKey).filter(
      (s) => s.positionId != null,
    );
    if (slotsWithPosition.length === 0) return;
    let openIds: Set<number>;
    try {
      openIds = await fetchLivePositionIds(
        this.cfg.apiBase,
        this.cfg.botAddress,
      );
    } catch (err) {
      this.logger.warn(
        "pipeline fetch failed; skipping position reconciliation this cycle",
        err,
      );
      return;
    }
    for (const slot of slotsWithPosition) {
      if (!openIds.has(slot.positionId!)) {
        this.logger.info("slot resolved (position no longer live)", {
          key: slot.key,
          positionId: slot.positionId,
        });
        // Terminal-cause check: a dropped position that was LIQUIDATED or
        // closed by the SERVER-side stop-loss arms the re-entry cooldown
        // (don't re-arm into the same move). The stop case also emits the
        // `stop_loss_closed` marker the fleet reports grep for — same event
        // name the retired bot-local stop used, so reporting stays
        // continuous. Read when the cooldown is configured OR a server SL
        // was registered (else skip the extra read).
        if (this.cfg.reentryCooldownMs || slot.slPrice != null) {
          try {
            const pos = await this.client.getPosition(slot.positionId!);
            if (pos && pos.status === "LIQUIDATED") {
              this.state.lastLiquidatedAt = Date.now();
              this.logger.info(
                "own liquidation observed — re-entry cooldown armed",
                {
                  key: slot.key,
                  positionId: slot.positionId,
                  cooldownMs: this.cfg.reentryCooldownMs,
                },
              );
            } else if (
              pos &&
              pos.status === "CLOSED" &&
              pos.closeMethod === "STOP_LOSS"
            ) {
              this.state.lastLiquidatedAt = Date.now();
              this.logger.info("stop_loss_closed", {
                key: slot.key,
                positionId: slot.positionId,
                slPrice: slot.slPrice,
                exitPrice: pos.exitPrice,
                serverFired: true,
              });
            }
          } catch (err) {
            this.logger.warn("getPosition failed in terminal-cause check", err);
          }
        }
        delete this.state.openByKey[slot.key];
      }
    }
  }

  /**
   * SERVER-side stop-loss registration (amplifi-native). For every FILLED
   * leveraged slot, register a backend stop at
   * entry × (1 − stopLossMarginFraction / leverage) — the same margin-loss
   * trigger the retired bot-local drift-stop fired on, but the BACKEND's
   * seconds-cadence monitor owns the firing (no bot-poll race against fast
   * wicks; the 2026-07-28 13:47 wick beat a 15s bot poll). Retries under
   * the same backoff schedule as TP. If the price can't clear the backend's
   * liq-price validation (deep-ITM at 9-10x leaves <1¢ of band), it bumps
   * to just above the stored liquidation price once, then marks the slot
   * `slSkipped` (liquidation remains its only downside protection).
   * Dry-run is implicitly excluded — no slot has a positionId in dry-run.
   */
  private async ensureStopLosses(): Promise<void> {
    if (!this.cfg.stopLossEnabled) return;
    const now = Date.now();
    for (const slot of Object.values(this.state.openByKey)) {
      if (slot.positionId == null || slot.leverage <= 1) continue;
      if (slot.slPrice != null || slot.slSkipped) continue;
      const failures = slot.slFailureCount ?? 0;
      if (failures >= TP_MAX_ATTEMPTS) continue;
      if (slot.slFailureAt != null) {
        const wait = Math.min(
          TP_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, failures - 1)),
          TP_BACKOFF_MAX_MS,
        );
        if (now - slot.slFailureAt < wait) continue;
      }
      const entry = tpAnchorPrice(slot.fillPrice, slot.limitPrice);
      if (!(Number.isFinite(entry) && entry > 0)) continue;
      const raw = entry * (1 - this.cfg.stopLossMarginFraction / slot.leverage);
      // 3-dp floor keeps the trigger conservative (never above the intended
      // margin-loss line); the backend stores the decimal as-is.
      const sl = Math.floor(raw * 1000) / 1000;
      if (!(sl > 0 && sl < 1)) {
        slot.slSkipped = true;
        continue;
      }
      try {
        await this.client.setStopLoss(slot.positionId, sl);
        slot.slPrice = sl;
        slot.slFailureCount = 0;
        slot.slFailureAt = null;
        this.logger.info("SL set (server)", {
          key: slot.key,
          positionId: slot.positionId,
          slPrice: sl,
          entry,
          leverage: slot.leverage,
          marginFraction: this.cfg.stopLossMarginFraction,
        });
        await this.store.save(this.state);
      } catch (err) {
        // Trigger at/below the position's stored liquidation price: the
        // backend rejects with 400 naming the liquidation bound. Bump to
        // just above the stored liq price; if even that fails, ride with
        // liquidation only.
        const belowLiq =
          err instanceof ApiError &&
          err.status === 400 &&
          /liquidation/i.test(err.body);
        if (belowLiq) {
          const pos = await this.client
            .getPosition(slot.positionId)
            .catch(() => null);
          const liq = pos ? parseFloat(pos.liquidationPrice) : NaN;
          const bumped =
            Number.isFinite(liq) && liq > 0
              ? Math.ceil((liq + 0.004) * 1000) / 1000
              : NaN;
          if (Number.isFinite(bumped) && bumped < 1) {
            try {
              await this.client.setStopLoss(slot.positionId, bumped);
              slot.slPrice = bumped;
              slot.slFailureCount = 0;
              slot.slFailureAt = null;
              this.logger.info("SL set (server, bumped above liq)", {
                key: slot.key,
                positionId: slot.positionId,
                slPrice: bumped,
                requested: sl,
                liquidationPrice: liq,
              });
              await this.store.save(this.state);
              continue;
            } catch {
              // fall through to slSkipped below
            }
          }
          slot.slSkipped = true;
          this.logger.warn("SL unplaceable — riding with liquidation only", {
            key: slot.key,
            positionId: slot.positionId,
            requested: sl,
            liquidationPrice: pos?.liquidationPrice ?? null,
          });
          await this.store.save(this.state);
          continue;
        }
        slot.slFailureCount = failures + 1;
        slot.slFailureAt = now;
        this.logger.warn("setStopLoss failed; will retry", {
          key: slot.key,
          positionId: slot.positionId,
          slPrice: sl,
          attempt: failures + 1,
          err: err instanceof ApiError ? err.body.slice(0, 200) : err,
        });
      }
    }
  }

  /** Cancel orders whose best-bid drifted up by ≥1 tick; next poll cycle
   *  will re-place at the new best-bid. Counter lives in
   *  `state.repriceCounts[key]` rather than on the slot, since the slot is
   *  deleted on cancel and a per-slot counter would always reset to 0 on
   *  re-create — defeating the `MAKER_MAX_REPRICES_PER_SLOT` cap. */
  private async maybeReprice(): Promise<void> {
    const now = Date.now();
    for (const slot of Object.values(this.state.openByKey)) {
      if (slot.positionId != null) continue; // already filled
      if (slot.orderId == null) continue; // dry-run / stale
      const reprices = this.state.repriceCounts[slot.key] ?? 0;
      if (reprices >= this.cfg.maker.maxRepricesPerSlot) continue;
      const restingFor = now - slot.lastPlacedAt;
      if (restingFor < this.cfg.maker.maxRestingAgeMs) continue;

      // Fetch the live book for the side we're buying. NO bets → trade on
      // the complement tokenId; YES bets → canonical tokenId.
      const market = await this.resolver
        .bySlugLookup(slot.marketSlug)
        .catch(() => null);
      if (!market) continue;
      const sideTokenId =
        slot.outcome === "NO" ? market.complementTokenId : market.tokenId;
      let book;
      try {
        book = await fetchBook(sideTokenId, slot.tickSize);
      } catch (err) {
        this.logger.warn("reprice book fetch failed", {
          marketSlug: slot.marketSlug,
          err,
        });
        continue;
      }
      if (book.bestBid == null) continue;

      const newLimit = floorToTick(book.bestBid, book.tickSize);
      if (newLimit <= slot.limitPrice + 1e-9) continue; // book hasn't moved up

      // Re-check the order's actual status before canceling: a slot whose
      // status drifted to PARTIALLY_FILLED already created a position for
      // the filled portion. Canceling would also wipe the loan-side
      // accounting — the backend's `OrderService.cancelOrder` calls
      // `proportionalLoanRepay` with the unfilled fraction, which the
      // `AmplifiLendingPool.repay()` contract treats as FINAL settlement
      // (always deletes `loanShares[loanId]`). The filled fraction's
      // principal is then realized as `BadDebtRealized` on the pool. So
      // any partial fill at cancel time = guaranteed bad debt event on top
      // of the double-open risk. Skip the cancel and let Pass 1 see the
      // eventual status; partial fills almost always complete within
      // minutes once underway.
      //
      // Check BOTH `status === "PARTIALLY_FILLED"` AND `sharesFilled > 0`.
      // The backend's `OrderFillMonitor` polls CLOB periodically — there's
      // a window where the CLOB has matched fills against our resting
      // order but the backend hasn't yet called `updateFillProgress` to
      // transition status. During that window `status` reads as
      // "RESTING" but the next reconcile will materialize fills.
      // sharesFilled > 0 catches both the post-update and any defensive
      // mid-update read where the value lands before the status flip.
      let liveStatus;
      try {
        const live = await this.client.getOrder(slot.orderId);
        liveStatus = live.status;
        const liveSharesFilled = live.sharesFilled
          ? Number(live.sharesFilled)
          : 0;
        if (
          live.status === "PARTIALLY_FILLED" ||
          (Number.isFinite(liveSharesFilled) && liveSharesFilled > 0)
        ) {
          // Capture the partial-fill positionId now so the slot is held to
          // resolution even if the rest of the order is never matched.
          if (live.positionId != null) {
            slot.positionId = live.positionId;
            const fillPrice = live.avgFillPrice
              ? Number(live.avgFillPrice)
              : slot.limitPrice;
            if (Number.isFinite(fillPrice) && fillPrice > 0) {
              slot.fillPrice = fillPrice;
            }
          }
          this.logger.info(
            "reprice: skipping cancel — order has partial fills",
            {
              key: slot.key,
              orderId: slot.orderId,
              status: live.status,
              positionId: live.positionId,
              sharesFilled: live.sharesFilled,
            },
          );
          continue;
        }
        if (live.status !== "RESTING") {
          // FILLED / CANCELED / FAILED / PENDING / PENDING_CANCEL — let
          // Pass 1 reconcile (or the backend sweeper resume, for
          // PENDING_CANCEL). Repricing a non-RESTING order is a no-op at
          // best and a confusing double-cancel error at worst.
          continue;
        }
      } catch (err) {
        this.logger.warn("reprice: getOrder failed before cancel, skipping", {
          orderId: slot.orderId,
          err: err instanceof ApiError ? err.body.slice(0, 200) : err,
        });
        continue;
      }

      this.logger.info("reprice: best-bid moved up, canceling", {
        key: slot.key,
        oldLimit: slot.limitPrice,
        newLimit,
        repriceCount: reprices,
        liveStatus,
      });
      try {
        await this.client.cancelOrder(slot.orderId);

        // Race window: between the pre-cancel `getOrder` check above (which
        // returned RESTING) and the cancel actually landing on the CLOB,
        // matching trades sitting ahead of the cancel can fill all or part
        // of the order. Backend's `OrderFillMonitor.materializeFillsIntoPosition`
        // creates a position for those fills with its own loan_id, and if we
        // delete the slot here the allocator's next pass re-places a fresh
        // full-collateral order against the SAME (event, market, outcome) —
        // double-committing margin + loan.
        //
        // Observed live on vm018 2026-05-19 07:14: bot 2 positions #456 +
        // #458 (same YES bitcoin-above-76k-on-may-19 strike) — pre-cancel
        // getOrder returned RESTING, cancel landed after 30.83 shares filled
        // → position #456 created from order #1630. Bot deleted the slot,
        // placed #1634 → also filled → position #458. Both got liquidated
        // on the next BTC dip for $8 of margin vs the $4 the slot was meant
        // to risk.
        //
        // Mitigation: re-poll the order after cancelOrder returns. If the
        // post-cancel `sharesFilled` is non-zero the backend will create
        // (or has already created) a position — keep the slot pointed at
        // this order so reconcile pass 1 attaches the positionId, and
        // SKIP the slot-delete so the allocator doesn't re-place.
        let postFilled = 0;
        let postPositionId: number | null = null;
        let postOk = false;
        try {
          const post = await this.client.getOrder(slot.orderId);
          postFilled = post.sharesFilled ? Number(post.sharesFilled) : 0;
          postPositionId = post.positionId;
          postOk = true;
        } catch (err) {
          this.logger.warn(
            "reprice: post-cancel getOrder failed — keeping slot to be safe (Pass 1 will re-check next tick)",
            {
              orderId: slot.orderId,
              err: err instanceof ApiError ? err.body.slice(0, 200) : err,
            },
          );
        }
        if (!postOk) {
          // Conservative: a network/API failure on the post-cancel re-check
          // cannot distinguish "order had zero fills" from "order partially
          // filled" — deleting the slot in the failure case defeats the
          // entire point of this fix (the cancel already succeeded, the
          // race window is open). Keep the slot; Pass 1 on the next tick
          // will retry getOrder and either attach the positionId (via the
          // CANCELED-with-fills guard) or drop the slot if truly empty.
          continue;
        }
        if (postFilled > 0) {
          if (postPositionId != null) {
            slot.positionId = postPositionId;
            // limitPrice is the executable price on a maker fill — see the
            // fallback in ensureTakeProfits. Recorded here so the TP path
            // has a non-null anchor on the next reconcile pass.
            slot.fillPrice ??= slot.limitPrice;
          }
          this.logger.info(
            "reprice: cancel landed AFTER partial/full fill — keeping slot to avoid double-open",
            {
              key: slot.key,
              orderId: slot.orderId,
              sharesFilled: postFilled,
              positionId: postPositionId,
            },
          );
          continue;
        }

        // Clean cancel — order is truly canceled with zero fills. Bump the
        // counter BEFORE deleting the slot so a SIGKILL between cancel and
        // save doesn't let the restart double-count down (orphan order +
        // fresh slot with count 0). Next poll's empty key re-enters
        // `tryPlaceMakerOrder`, which seeds the new slot's reprice count
        // from `state.repriceCounts[key]`.
        this.logger.info("reprice: clean cancel — slot freed for re-place", {
          key: slot.key,
          orderId: slot.orderId,
          newRepriceCount: reprices + 1,
        });
        this.state.repriceCounts[slot.key] = reprices + 1;
        delete this.state.openByKey[slot.key];
      } catch (err) {
        this.logger.warn("cancelOrder failed; will retry", {
          orderId: slot.orderId,
          err: err instanceof ApiError ? err.body.slice(0, 200) : err,
        });
      }
    }
  }

  /** For every filled slot that doesn't yet have a registered take-profit,
   *  compute the target price and call setTakeProfit. With `tpRoePct` set
   *  the target is the ROE-on-collateral price; otherwise it falls back to
   *  a fixed `DEFAULT_TP_PRICE` so the slot books most of its profit and
   *  releases collateral before resolution. The backend enforces
   *  `tp > bestBid` and rejects any tp outside (0, 1), so the helpers
   *  snap to the side's tick and `skip` values that would round to ≥1
   *  or land at/below fillPrice. */
  private async ensureTakeProfits(): Promise<void> {
    const roePct = this.cfg.tpRoePct;
    const now = Date.now();
    for (const slot of Object.values(this.state.openByKey)) {
      if (slot.positionId == null) continue;
      if (slot.tpPrice != null) continue;
      if (slot.tpSkipped) continue;
      // Maker GTC orders only fill at the limit we placed (someone has to
      // lift our resting bid), so when fillPrice wasn't captured —
      // upgraded state files from before the TP fields existed, the
      // post-cancel-with-fills path in maybeReprice, or a taker open whose
      // entry price came back 0 — `limitPrice` is the safe and accurate
      // stand-in. `tpAnchorPrice` guards the 0-fill trap (a plain `??` would
      // keep 0 and skip the TP forever). The calc treats this as the anchor
      // for ROE on collateral.
      const fillPrice = tpAnchorPrice(slot.fillPrice, slot.limitPrice);
      if (!(Number.isFinite(fillPrice) && fillPrice > 0)) continue;
      if (slot.tpFailureCount >= TP_MAX_ATTEMPTS) continue;
      if (slot.tpFailureAt != null) {
        const wait = Math.min(
          TP_BACKOFF_BASE_MS *
            Math.pow(2, Math.max(0, slot.tpFailureCount - 1)),
          TP_BACKOFF_MAX_MS,
        );
        if (now - slot.tpFailureAt < wait) continue;
      }
      // ROE-priced when `tpRoePct` is set, falling back to the fixed
      // DEFAULT_TP_PRICE when the ROE target lands out of range (deep-ITM at
      // low leverage pushes it ≥ 1) or once the book has bid past it
      // (`tpForceFixed`). Fixed price when `tpRoePct` is unset.
      const decision = chooseTpDecision({
        fillPrice,
        leverage: slot.leverage,
        roePct,
        tickSize: slot.tickSize,
        forceFixed: slot.tpForceFixed,
      });
      if (decision.kind === "skip") {
        this.logger.warn("skip: TP price outside (fillPrice, 1)", {
          key: slot.key,
          positionId: slot.positionId,
          fillPrice,
          leverage: slot.leverage,
          tpRoePct: roePct ?? `unset (fixed @ ${DEFAULT_TP_PRICE})`,
          tpRaw: decision.tpRaw,
          tpTick: decision.tpTick,
        });
        // Even the fixed DEFAULT_TP_PRICE is out of range (fill already
        // ≥ 1 − tickSize). Mark and ride to resolution.
        slot.tpSkipped = true;
        continue;
      }
      const tpTick = decision.tpPrice;
      try {
        await this.client.setTakeProfit(slot.positionId, tpTick);
        slot.tpPrice = tpTick;
        slot.tpFailureCount = 0;
        slot.tpFailureAt = null;
        this.logger.info("TP set", {
          key: slot.key,
          positionId: slot.positionId,
          fillPrice,
          leverage: slot.leverage,
          tpRoePct: roePct ?? `unset (fixed @ ${DEFAULT_TP_PRICE})`,
          tpPrice: tpTick,
        });
      } catch (err) {
        // The backend rejects setTakeProfit with 409 + "in-flight buy
        // order" while a partial-fill buy is still acquiring shares
        // (PolymarketPositionService blocks TP until the BUY settles so
        // the eventual SELL covers the FINAL size, not a snapshot). For
        // slots that reached `ensureTakeProfits` via maybeReprice's
        // PARTIALLY_FILLED branch this fires immediately. Treat as
        // deferred-not-failed so the retry budget is reserved for real
        // failures (e.g. tp < bestBid because the market moved).
        const isInflightBuy =
          err instanceof ApiError &&
          err.status === 409 &&
          /in-flight buy order/i.test(err.body);
        if (isInflightBuy) {
          this.logger.info("TP deferred — buy still in flight", {
            key: slot.key,
            positionId: slot.positionId,
            tpPrice: tpTick,
          });
          continue;
        }
        // The book bid past our ROE target, so a resting TP at that price is
        // rejected ("must be above current best bid"). Escalate to the fixed
        // DEFAULT_TP_PRICE (above the bid in deep-ITM books) on the next
        // attempt instead of re-trying the same now-stale ROE price. Compare
        // against the FLOORED fixed price the escalation will actually use —
        // on a coarse tick (e.g. 0.01) raw 0.999 floors to 0.99, so a tpTick
        // of 0.995 must NOT escalate to a guaranteed-lower (and re-rejected)
        // fixed price. Once set, `tpForceFixed` is intentionally never reset:
        // a slot that reached its ROE target rides the fixed 0.999 to
        // resolution rather than chasing the ROE price back down (mirrors
        // `tpSkipped`).
        const fixedTpTick = floorToTick(DEFAULT_TP_PRICE, slot.tickSize);
        const isBidRejection =
          err instanceof ApiError && /above current best bid/i.test(err.body);
        // Volume-first active take-profit: the book has bid PAST our ROE
        // target, so the market is offering at least our target profit right
        // now. Rather than park a resting TP at the fixed 0.999 ceiling —
        // which sits behind the deep-ITM sell wall and rides to resolution
        // with no recycling — cross the spread and close at market to bank the
        // gain and free the collateral for the next cycle. Opt-in via
        // `tpActiveExit`; only meaningful with an ROE target (the level we've
        // run past). On close failure, fall through to the fixed-TP escalation
        // so the slot is never left unmanaged. reconcile Pass 4 drops the slot
        // once the close lands and the position is no longer live.
        if (isBidRejection && roePct != null && this.cfg.tpActiveExit) {
          try {
            await this.client.closePosition(slot.positionId);
            slot.tpSkipped = true;
            this.logger.info(
              "TP active-exit: closed at market (book bid past ROE target)",
              { key: slot.key, positionId: slot.positionId, roeTarget: tpTick },
            );
            continue;
          } catch (closeErr) {
            this.logger.warn(
              "TP active-exit close failed; falling back to fixed TP",
              {
                key: slot.key,
                positionId: slot.positionId,
                err:
                  closeErr instanceof ApiError
                    ? closeErr.body.slice(0, 200)
                    : closeErr,
              },
            );
          }
        }
        if (
          isBidRejection &&
          roePct != null &&
          !slot.tpForceFixed &&
          tpTick < fixedTpTick
        ) {
          slot.tpForceFixed = true;
        }
        slot.tpFailureCount++;
        slot.tpFailureAt = now;
        this.logger.warn("setTakeProfit failed; backing off", {
          key: slot.key,
          positionId: slot.positionId,
          attempt: slot.tpFailureCount,
          tpPrice: tpTick,
          err:
            err instanceof ApiError
              ? { status: err.status, body: err.body.slice(0, 200) }
              : err instanceof Error
                ? err.message
                : err,
        });
      }
    }
  }

  private async tryPlaceMakerOrder(
    key: string,
    t: AllocationTarget,
  ): Promise<void> {
    // Resolve Amplifi-side market by slug. Amplifi only accepts opens on
    // markets it has ingested via MarketAutoIngestService.
    const market = await this.resolver.bySlugLookup(t.marketSlug);
    if (!market) {
      this.logger.info("skip: market not on amplifi yet", {
        slug: t.marketSlug,
      });
      return;
    }

    const canonicalYesTokenId = market.tokenId;

    // The server's leverage cap is price-keyed per outcome side
    // (`getMaxLeverageForPrice` in src/core/leverage.ts). Use the
    // side-correct cap exposed by /polymarket/markets — `maxLeverage` is
    // the YES-side cap, `noMaxLeverage` is the NO-side cap (added in
    // PR #1053). The optional fallback to YES-side `maxLeverage` keeps
    // the bot working against API revisions that don't yet emit
    // `noMaxLeverage`.
    const sideMaxLeverage =
      t.outcome === "NO"
        ? (market.noMaxLeverage ?? market.maxLeverage)
        : market.maxLeverage;

    let leverage = Math.min(t.leverage, sideMaxLeverage);
    if (leverage < t.leverage) {
      this.logger.warn("clamping leverage to market max", {
        requested: t.leverage,
        marketMax: sideMaxLeverage,
        side: t.outcome,
        marketSlug: t.marketSlug,
      });
    }

    let collateral = t.collateralUsd;

    // Per-market notional cap: clamp leverage first, then collateral.
    if (
      market.maxNotionalPerUser != null &&
      collateral * leverage > market.maxNotionalPerUser
    ) {
      const cap = market.maxNotionalPerUser;
      const cappedLev = Math.floor(cap / collateral);
      if (cappedLev >= 1) {
        this.logger.warn("clamping leverage to fit market notional cap", {
          cap,
          collateral,
          requestedLeverage: leverage,
          newLeverage: cappedLev,
          marketSlug: t.marketSlug,
        });
        leverage = cappedLev;
      } else {
        this.logger.warn("clamping collateral to fit market notional cap", {
          cap,
          requestedCollateral: collateral,
          newCollateral: cap,
          newLeverage: 1,
          marketSlug: t.marketSlug,
        });
        collateral = cap;
        leverage = 1;
      }
    }

    if (collateral < this.cfg.collateralFloorUsd) {
      this.logger.info("skip: target collateral below floor", {
        marketSlug: t.marketSlug,
        targetUsd: t.collateralUsd,
        floorUsd: this.cfg.collateralFloorUsd,
      });
      return;
    }

    // Fetch the live CLOB book for the side we're buying. Side = NO trades
    // on `complementTokenId`, YES trades on `tokenId`. Polymarket exposes a
    // single-token /book endpoint so this is a 1-RTT call per target.
    const sideTokenId =
      t.outcome === "NO" ? market.complementTokenId : market.tokenId;
    let book;
    try {
      book = await fetchBook(sideTokenId, this.cfg.maker.defaultTickSize);
    } catch (err) {
      this.logger.warn("skip: orderbook fetch failed", {
        marketSlug: t.marketSlug,
        err: err instanceof Error ? err.message : err,
      });
      return;
    }
    if (book.bestBid == null) {
      // One-sided book on the buy side — no resting bid means we'd be the
      // ONLY bid, with no counterparty to hit us in the foreseeable future.
      // Skip and let the next poll retry; matches the harvester's
      // "wait for a quote" stance.
      this.logger.info(
        "skip: no bid on side book — maker order would never fill",
        {
          marketSlug: t.marketSlug,
          side: t.outcome,
        },
      );
      return;
    }
    // Final-mile bucket guard. Between the allocator's snapshot and now the
    // live best-bid may have drifted into a different bucket — refuse to
    // open if so. Mirrors the resolveLiveStrikePrices live-price contract:
    // a target approved for bucket X must actually fill in bucket X.
    const liveBucket = priceToBucket(book.bestBid);
    if (liveBucket !== t.bucket) {
      this.logger.info("skip: live bucket drifted from target bucket", {
        marketSlug: t.marketSlug,
        side: t.outcome,
        targetBucket: t.bucket,
        liveBestBid: book.bestBid,
        liveBucket,
      });
      return;
    }
    const limitPrice = floorToTick(book.bestBid, book.tickSize);
    if (priceToBucket(limitPrice) !== t.bucket) {
      // Tick rounding could push the limit across the bucket boundary
      // (best-bid 0.97 → tick-floor 0.97 stays in 0.97-0.99; best-bid
      // 0.9699 → floor 0.96 falls into 0.95-0.97). Refuse rather than
      // post a maker order in a bucket the allocator didn't approve.
      this.logger.info(
        "skip: tick-floored limit price falls outside target bucket",
        {
          marketSlug: t.marketSlug,
          targetBucket: t.bucket,
          limitPrice,
          bestBid: book.bestBid,
          tickSize: book.tickSize,
        },
      );
      return;
    }
    if (!(limitPrice > 0 && limitPrice < 1)) {
      this.logger.warn("skip: derived limit price out of CLOB range", {
        marketSlug: t.marketSlug,
        limitPrice,
        bestBid: book.bestBid,
      });
      return;
    }

    if (this.cfg.dryRun) {
      this.logger.info("DRY-RUN: would place limit", {
        bucket: t.bucket,
        dayIndex: t.dayIndex,
        marketSlug: t.marketSlug,
        outcome: t.outcome,
        collateralUsd: collateral,
        leverage,
        limitPrice,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        tickSize: book.tickSize,
      });
      this.state.openByKey[key] = {
        key,
        eventSlug: t.eventSlug,
        marketSlug: t.marketSlug,
        conditionId: market.conditionId,
        tokenId: canonicalYesTokenId,
        outcome: t.outcome,
        bucket: t.bucket,
        leverage,
        collateralUsd: collateral,
        limitPrice,
        tickSize: book.tickSize,
        orderId: this.dryRunOrderSeq--,
        positionId: null,
        lastPlacedAt: Date.now(),
        repriceCount: this.state.repriceCounts[key] ?? 0,
        fillPrice: null,
        tpPrice: null,
        tpSkipped: false,
        tpForceFixed: false,
        tpFailureCount: 0,
        tpFailureAt: null,
      };
      await this.store.save(this.state);
      return;
    }

    try {
      const order = await this.client.placeLimitOrder({
        tokenId: canonicalYesTokenId,
        outcome: t.outcome,
        leverage,
        marginUsdc: collateral,
        limitPrice,
      });
      this.state.openByKey[key] = {
        key,
        eventSlug: t.eventSlug,
        marketSlug: t.marketSlug,
        conditionId: market.conditionId,
        tokenId: canonicalYesTokenId,
        outcome: t.outcome,
        bucket: t.bucket,
        leverage,
        collateralUsd: collateral,
        limitPrice,
        tickSize: book.tickSize,
        orderId: order.id,
        positionId: null,
        lastPlacedAt: Date.now(),
        repriceCount: this.state.repriceCounts[key] ?? 0,
        fillPrice: null,
        tpPrice: null,
        tpSkipped: false,
        tpForceFixed: false,
        tpFailureCount: 0,
        tpFailureAt: null,
      };
      // Persist immediately so a SIGKILL between placeLimitOrder and the
      // end of the poll can't orphan a live order with no state record.
      await this.store.save(this.state);
      this.logger.info("PLACED", {
        orderId: order.id,
        status: order.status,
        bucket: t.bucket,
        dayIndex: t.dayIndex,
        marketSlug: t.marketSlug,
        outcome: t.outcome,
        collateralUsd: collateral,
        leverage,
        limitPrice,
      });
    } catch (err) {
      this.logger.error(
        "placeLimitOrder failed",
        err instanceof ApiError
          ? { status: err.status, body: err.body.slice(0, 300) }
          : err,
      );
    }
  }

  /** Taker-mode open: FAK market order via /polymarket/positions/open. No
   *  book fetch, no resting order, no reprice. The slot lands with
   *  positionId already populated so `reconcileState` Pass 1/2 don't touch
   *  it; Pass 3 (TP) and Pass 4 (live-position check) run as for any
   *  filled slot. */
  private async tryOpenTaker(key: string, t: AllocationTarget): Promise<void> {
    const market = await this.resolver.bySlugLookup(t.marketSlug);
    if (!market) {
      this.logger.info("skip: market not on amplifi yet", {
        slug: t.marketSlug,
      });
      return;
    }

    const canonicalYesTokenId = market.tokenId;

    // Same side-aware leverage cap as the maker path.
    const sideMaxLeverage =
      t.outcome === "NO"
        ? (market.noMaxLeverage ?? market.maxLeverage)
        : market.maxLeverage;

    let leverage = Math.min(t.leverage, sideMaxLeverage);
    if (leverage < t.leverage) {
      this.logger.warn("clamping leverage to market max", {
        requested: t.leverage,
        marketMax: sideMaxLeverage,
        side: t.outcome,
        marketSlug: t.marketSlug,
      });
    }

    let collateral = t.collateralUsd;

    if (
      market.maxNotionalPerUser != null &&
      collateral * leverage > market.maxNotionalPerUser
    ) {
      const cap = market.maxNotionalPerUser;
      const cappedLev = Math.floor(cap / collateral);
      if (cappedLev >= 1) {
        this.logger.warn("clamping leverage to fit market notional cap", {
          cap,
          collateral,
          requestedLeverage: leverage,
          newLeverage: cappedLev,
          marketSlug: t.marketSlug,
        });
        leverage = cappedLev;
      } else {
        this.logger.warn("clamping collateral to fit market notional cap", {
          cap,
          requestedCollateral: collateral,
          newCollateral: cap,
          newLeverage: 1,
          marketSlug: t.marketSlug,
        });
        collateral = cap;
        leverage = 1;
      }
    }

    if (collateral < this.cfg.collateralFloorUsd) {
      this.logger.info("skip: target collateral below floor", {
        marketSlug: t.marketSlug,
        targetUsd: t.collateralUsd,
        floorUsd: this.cfg.collateralFloorUsd,
      });
      return;
    }

    // Final-mile bucket guard for the taker path — fetch the live CLOB
    // book RIGHT before submitting the FAK order so the bucket the order
    // fills in matches the bucket the allocator/stability gate approved.
    // No fallback: if the live bid is unavailable, refuse to open. Same
    // contract as the maker path. See `resolveLiveStrikePrices`.
    const takerSideTokenId =
      t.outcome === "NO" ? market.complementTokenId : market.tokenId;
    if (!takerSideTokenId) {
      this.logger.warn("skip (taker): missing side tokenId", {
        marketSlug: t.marketSlug,
        side: t.outcome,
      });
      return;
    }
    try {
      const takerBook = await fetchBook(
        takerSideTokenId,
        this.cfg.maker.defaultTickSize,
      );
      if (takerBook.bestBid == null) {
        this.logger.info("skip (taker): no live bid on side book", {
          marketSlug: t.marketSlug,
          side: t.outcome,
        });
        return;
      }
      const liveBucket = priceToBucket(takerBook.bestBid);
      if (liveBucket !== t.bucket) {
        this.logger.info(
          "skip (taker): live bucket drifted from target bucket",
          {
            marketSlug: t.marketSlug,
            side: t.outcome,
            targetBucket: t.bucket,
            liveBestBid: takerBook.bestBid,
            liveBucket,
          },
        );
        return;
      }
    } catch (err) {
      this.logger.warn("skip (taker): orderbook fetch failed", {
        marketSlug: t.marketSlug,
        err: err instanceof Error ? err.message : err,
      });
      return;
    }

    if (this.cfg.dryRun) {
      const fakePositionId = this.dryRunPositionSeq--;
      this.logger.info("DRY-RUN: would open (taker)", {
        bucket: t.bucket,
        dayIndex: t.dayIndex,
        marketSlug: t.marketSlug,
        outcome: t.outcome,
        collateralUsd: collateral,
        leverage,
        entryPriceMid: t.entryPriceMid,
      });
      this.state.openByKey[key] = {
        key,
        eventSlug: t.eventSlug,
        marketSlug: t.marketSlug,
        conditionId: market.conditionId,
        tokenId: canonicalYesTokenId,
        outcome: t.outcome,
        bucket: t.bucket,
        leverage,
        collateralUsd: collateral,
        limitPrice: t.entryPriceMid,
        tickSize: this.cfg.maker.defaultTickSize,
        orderId: null,
        positionId: fakePositionId,
        lastPlacedAt: Date.now(),
        repriceCount: 0,
        fillPrice: t.entryPriceMid,
        tpPrice: null,
        tpSkipped: false,
        tpForceFixed: false,
        tpFailureCount: 0,
        tpFailureAt: null,
      };
      await this.store.save(this.state);
      return;
    }

    try {
      const res = await this.client.openPosition({
        tokenId: canonicalYesTokenId,
        conditionId: market.conditionId,
        outcome: t.outcome,
        usdcAmount: collateral.toFixed(6),
        leverage,
        slug: market.slug,
      });
      const entryPrice = Number(res.entryPrice);
      // Taker opens often return entryPrice 0 (fill price not known
      // synchronously). Treat only a positive value as real — otherwise
      // anchor on the targeted mid so `limitPrice` is never 0 (a 0 stand-in
      // would skip the take-profit) and leave `fillPrice` null until/unless
      // a real price is known, mirroring the maker path.
      const haveEntry = entryPrice > 0;
      this.state.openByKey[key] = {
        key,
        eventSlug: t.eventSlug,
        marketSlug: t.marketSlug,
        conditionId: market.conditionId,
        tokenId: canonicalYesTokenId,
        outcome: t.outcome,
        bucket: t.bucket,
        leverage,
        collateralUsd: collateral,
        limitPrice: haveEntry ? entryPrice : t.entryPriceMid,
        tickSize: this.cfg.maker.defaultTickSize,
        orderId: null,
        positionId: res.positionId,
        lastPlacedAt: Date.now(),
        repriceCount: 0,
        fillPrice: haveEntry ? entryPrice : null,
        tpPrice: null,
        tpSkipped: false,
        tpForceFixed: false,
        tpFailureCount: 0,
        tpFailureAt: null,
      };
      // Persist before logging so an unlikely crash between openPosition
      // and end-of-poll save still leaves an attributable slot.
      await this.store.save(this.state);
      this.logger.info("OPENED (taker)", {
        positionId: res.positionId,
        bucket: t.bucket,
        dayIndex: t.dayIndex,
        marketSlug: t.marketSlug,
        outcome: t.outcome,
        collateralUsd: collateral,
        leverage,
        entryPrice: res.entryPrice,
        status: res.status,
      });
    } catch (err) {
      this.logger.error(
        "openPosition (taker) failed",
        err instanceof ApiError
          ? { status: err.status, body: err.body.slice(0, 300) }
          : err,
      );
    }
  }
}

// Re-export for unit tests / external callers.
export type { BtcDailyEvent };
