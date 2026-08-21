import { type Address, type Hex, isAddress, getAddress } from "viem";
import { parseOrderMode, type OrderMode } from "./order-mode.ts";
import { defaultStateFilePath } from "../../common/src/state-store.ts";
import {
  DEFAULT_DAY_WEIGHTS,
  type Bucket,
  type LeveragePerBucket,
  type HoursPerBucket,
} from "./allocator.ts";
import { DEFAULT_BTC_DAILY_SERIES_ID } from "./btc-daily.ts";
import { parseVolRules, type VolRule } from "../../common/src/vol-gate.ts";

/** STOP_LOSS_MARGIN_FRACTION parser: default 0.5, must be in (0, 1). */
export function parseStopFraction(spec: string | undefined): number {
  if (spec === undefined || spec.trim().length === 0) return 0.5;
  const f = Number(spec);
  if (!Number.isFinite(f) || f <= 0 || f >= 1)
    throw new Error(
      `STOP_LOSS_MARGIN_FRACTION must be a number in (0, 1), got "${spec}"`,
    );
  return f;
}

export interface BucketBotConfig {
  apiBase: string;
  botPrivateKey: Hex;
  botAddress: Address;
  /** Bot capital cap. The allocator caps total deployment at this value;
   *  any Amplifi balance above this stays idle. Operator funds the bot's
   *  Amplifi balance up front — the bot never auto-deposits. */
  totalCapitalUsd: number;
  /** Poll cadence for Gamma + balance + open-position reconciliation. */
  pollIntervalMs: number;
  /** Number of forward days to allocate across. Default 6. */
  days: number;
  /** Gamma series id for BTC daily-above events. Override via
   *  `BTC_DAILY_SERIES_ID` if Polymarket ever reshuffles series ids. */
  btcDailySeriesId: number;
  /** Day allocation weights, length = `days`. Default 40/25/12.5/eq*3. */
  dayWeights: readonly number[];
  /** Buckets this bot will trade. Use a single-bucket set for the per-bucket
   *  profile flavors, or all three for an aggregate profile. */
  allowedBuckets: ReadonlySet<Bucket>;
  /** Leverage per bucket. Maker-optimal defaults from the 500ms backtest. */
  leveragePerBucket: LeveragePerBucket;
  /** When true: split each day's budget 50/50 between strikes-above-BTC
   *  and strikes-below-BTC. Sat on one of the 3 production bots. */
  restricted: boolean;
  dryRun: boolean;
  stateFile: string;
  /** Smallest collateral we'll submit to Amplifi for a single market.
   *  CLOB rejects < $1 notional, so any target below this is clamped or
   *  skipped depending on `clampSmallTargetsToFloor`. */
  collateralFloorUsd: number;
  /** Maker-first order placement knobs. */
  maker: MakerConfig;
  /** Optional take-profit % return on collateral. When set, the bot places
   *  a TP limit-sell as soon as a slot's buy fills. The TP fires when ROE
   *  on the slot's collateral reaches this value, i.e.
   *    tpPrice = fillPrice × (1 + tpRoePct / (leverage × 100))
   *  When unset, the bot still places a TP — at the fixed
   *  `DEFAULT_TP_PRICE` (see `tp.ts`) — so capital is freed before
   *  resolution instead of riding every slot to expiry. After a TP fires,
   *  the position closes on-chain and the freed margin is naturally
   *  recycled by the next allocator pass. */
  tpRoePct?: number;
  /** Volume-first active take-profit. When true (and `tpRoePct` is set):
   *  if the book has already bid PAST the ROE target by the time we go to
   *  register the TP (the "must be above current best bid" rejection), close
   *  the position at market to bank the (≥ target) profit and recycle the
   *  collateral immediately — instead of parking a resting TP at the fixed
   *  `DEFAULT_TP_PRICE` ceiling, which sits behind the deep-ITM sell wall and
   *  rides to resolution with no recycling (dead capital, no volume). Crossing
   *  the spread costs a tiny taker fee (≈0 in deep-ITM where p(1−p) is small)
   *  but keeps capital turning, which is the point of a volume fleet. Default
   *  false — preserves the ride-to-resolution behavior. */
  tpActiveExit: boolean;
  /** Optional resolution-time gate. When set, the bot skips any event whose
   *  end_date is more than this many hours away — i.e. markets resolving
   *  beyond the threshold are treated as "no-event" days and their budget
   *  stays idle. Liquidation-rate analysis on lifetime + synthetic data
   *  showed the danger zone starts ~36h before resolution: trades opened
   *  with 36-72h to resolution have 33-67% liq rates vs ~10% in the <24h
   *  window. Defaults to unset (no limit) for backwards compatibility.
   *
   *  NOTE: this is now the COARSE, event-level cutoff = the loosest (max) of
   *  `maxHoursPerBucket`. Whole events beyond it are dropped before the
   *  allocator runs; the allocator then applies the precise per-bucket cap. */
  maxHoursToResolution?: number;
  /** Per-bucket max hours-to-resolution at open (precise gate, applied in the
   *  allocator). Each bucket defaults to `MAX_HOURS_TO_RESOLUTION`; override
   *  per bucket with `MAX_HOURS_90_95` / `_95_97` / `_97_99` / `_99_PLUS`.
   *  Deep buckets only profit opened close to resolution; shallow buckets
   *  tolerate longer windows. undefined per bucket = no cap. */
  maxHoursPerBucket: HoursPerBucket;
  /** Per-bucket min hours-to-resolution at open. Each bucket defaults to
   *  `MIN_HOURS_TO_RESOLUTION`; override with `MIN_HOURS_90_95` / … Drops
   *  entries too close to settlement (thin/clearing books). undefined = no
   *  floor. */
  minHoursPerBucket: HoursPerBucket;
  /** Hard ceiling on entry price. Strikes whose qualifying side trades at
   *  or above this are dropped — the per-share upside (1−p) is too thin to
   *  beat fee + interest even when leveraged. */
  maxEntryPrice?: number;
  /** Interest-aware ROI floor on collateral, as a percent (2 = 2%). When
   *  set together with `lendingPoolAddress`, qualifying strikes must clear
   *  this hurdle after subtracting borrow interest accrued through
   *  resolution. Below 0.99 the upside is naturally larger than any
   *  realistic APR can erode; the gate effectively only bites in the
   *  0.99-to-`maxEntryPrice` band. */
  minRoiAfterInterestPct?: number;
  /** Address of the AmplifiLendingPool on Polygon. Required when the ROI
   *  gate is engaged — we read live `borrowRate()` from it. */
  lendingPoolAddress?: Address;
  /** Polygon RPC override. Used by the lending-pool reader. */
  polygonRpcUrl?: string;
  /** Minutes a market must continuously sit in its target bucket before
   *  the bot opens. Default unset = no stability gate. Reduces liquidation
   *  rate by skipping markets that briefly dip into the bucket and
   *  bounce back out. */
  bucketStabilityWindowMin?: number;
  /** Optional cap on per-target collateral. Days with many qualifying
   *  strikes won't over-concentrate capital when this is set; the cap
   *  takes priority over even-share-across-strikes, with surplus capital
   *  left idle. Default unset (no cap). */
  maxPositionCollateralUsd?: number;
  /** "maker" (default — current behavior; GTC limit at best bid via
   *  /polymarket/orders) or "taker" (FAK market order via
   *  /polymarket/positions/open). High-bucket markets have minuscule
   *  Polymarket taker fees, so the immediate-fill advantage may
   *  outweigh the maker rebate. */
  orderMode: OrderMode;
  /** Optional anti-volatility open-gate (shared `BtcVolGate`). When true, the
   *  bot skips opening a new position while BTC's absolute move over any
   *  configured window exceeds that window's threshold. Default false. */
  volGateEnabled: boolean;
  /** Gate rules (window + threshold %). Defaults to 15m>0.8% OR 4h>2.0%.
   *  Configure with VOL_GATE_RULES, e.g. "15m:0.8,4h:2.0,1d:5". A trailing
   *  ":dir" makes a rule directional — it blocks only the side the move hurts
   *  (a rise blocks NO, a fall blocks YES), e.g. "48h:5:dir,15m:1:dir". */
  volRules: VolRule[];
  /** Milliseconds between BTC spot polls feeding the gate. Default 20_000. */
  btcVolPollMs: number;
  /** Block opens for this many ms after THIS bot's own liquidation
   *  (shape-independent re-entry guard). Default unset (off). */
  reentryCooldownMs?: number;
  /** Drift stop-loss: close a filled leveraged position at market once it
   *  has lost `stopLossMarginFraction` of its initial margin, instead of
   *  riding a slow grind all the way to the liquidation trigger (which
   *  costs ~100% of margin plus the liquidation penalty). Default false. */
  stopLossEnabled: boolean;
  /** Fraction of initial margin lost that triggers the stop, in (0, 1).
   *  Default 0.5 — roughly halfway to the liquidation trigger. */
  stopLossMarginFraction: number;
  /** Skip the stop within this many ms of the event's resolution — the book
   *  thins near settlement and the backend's liquidation/redemption engine
   *  handles the endgame better than a market close. Default 45 min. */
}

export interface MakerConfig {
  /** How long a slot can sit RESTING before we consider repricing. The
   *  reprice check only cancels if the book's best-bid has actually moved
   *  up — otherwise the order stays put. */
  maxRestingAgeMs: number;
  /** Cap on cancel+replace cycles per slot, to bound spend in pathological
   *  drift scenarios. After this many reprices we leave the order in place
   *  and accept that the slot may not fill. */
  maxRepricesPerSlot: number;
  /** Tick-size fallback when /book doesn't include `tick_size`. Polymarket
   *  binary markets use 0.001 (0.1¢) when YES is in (0.1, 0.9), and 0.01
   *  near tails — 0.001 is the safer default since our targets cluster in
   *  the deep-ITM / deep-OTM bands. */
  defaultTickSize: number;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "")
    throw new Error(`Missing required env var: ${name}`);
  return v.trim();
}

function parseBuckets(raw: string | undefined): ReadonlySet<Bucket> {
  // Default = all four. A comma-separated list narrows the set. `0.97+` is
  // a legacy alias that maps to both `0.97-0.99` and `0.99+` so existing
  // bot envs (LEVERAGE_97_PLUS-only) keep their behavior unchanged.
  if (!raw || raw.trim() === "")
    return new Set<Bucket>(["0.90-0.95", "0.95-0.97", "0.97-0.99", "0.99+"]);
  const out = new Set<Bucket>();
  for (const tok of raw.split(",").map((s) => s.trim())) {
    if (
      tok === "0.90-0.95" ||
      tok === "0.95-0.97" ||
      tok === "0.97-0.99" ||
      tok === "0.99+"
    ) {
      out.add(tok);
    } else if (tok === "0.97+") {
      out.add("0.97-0.99");
      out.add("0.99+");
    } else {
      throw new Error(
        `BUCKETS contains unknown bucket "${tok}". Allowed: 0.90-0.95, 0.95-0.97, 0.97-0.99, 0.99+ (alias "0.97+" expands to both upper buckets)`,
      );
    }
  }
  if (out.size === 0)
    throw new Error("BUCKETS evaluated to empty set after parsing");
  return out;
}

function parseDayWeights(
  raw: string | undefined,
  days: number,
): readonly number[] {
  if (!raw || raw.trim() === "") {
    if (days === DEFAULT_DAY_WEIGHTS.length) return DEFAULT_DAY_WEIGHTS;
    throw new Error(
      `DAY_WEIGHTS not set but DAYS=${days} != default ${DEFAULT_DAY_WEIGHTS.length}. ` +
        `Set DAY_WEIGHTS=w0,w1,... (length ${days}).`,
    );
  }
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== days)
    throw new Error(`DAY_WEIGHTS length ${parts.length} != DAYS ${days}`);
  for (const p of parts)
    if (!Number.isFinite(p) || p < 0)
      throw new Error(`DAY_WEIGHTS contains invalid value: ${p}`);
  const sum = parts.reduce((s, x) => s + x, 0);
  if (Math.abs(sum - 1) > 1e-6)
    throw new Error(`DAY_WEIGHTS must sum to 1 (got ${sum})`);
  return parts;
}

export function loadConfig(): BucketBotConfig {
  const botPrivateKey = req("BOT_PRIVATE_KEY") as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(botPrivateKey))
    throw new Error("BOT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string");

  const rawBot = req("BOT_ADDRESS");
  if (!isAddress(rawBot))
    throw new Error(`BOT_ADDRESS is not a valid address: ${rawBot}`);

  const dryRun = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
  const defaultStateFile = defaultStateFilePath("bots/bucket", dryRun);
  const stateFileEnv = process.env.STATE_FILE?.trim();

  const totalCapitalUsd = Number(process.env.TOTAL_CAPITAL_USD ?? 100);
  if (!(totalCapitalUsd > 0)) throw new Error("TOTAL_CAPITAL_USD must be > 0");

  if (process.env.INITIAL_DEPOSIT_USD) {
    console.warn(
      "[config] INITIAL_DEPOSIT_USD is deprecated and ignored. The bot no longer auto-deposits; fund the bot's Amplifi balance up front yourself.",
    );
  }

  const days = Number(process.env.DAYS ?? 6);
  if (!(Number.isInteger(days) && days > 0 && days <= 14))
    throw new Error("DAYS must be an integer in [1, 14]");

  const btcDailySeriesId = Number(
    process.env.BTC_DAILY_SERIES_ID ?? DEFAULT_BTC_DAILY_SERIES_ID,
  );
  if (!(Number.isInteger(btcDailySeriesId) && btcDailySeriesId > 0))
    throw new Error("BTC_DAILY_SERIES_ID must be a positive integer");

  const dayWeights = parseDayWeights(process.env.DAY_WEIGHTS, days);

  const allowedBuckets = parseBuckets(process.env.BUCKETS);

  // Per-bucket leverage. Each entry-price bucket has an empirical liquidation
  // "cliff" — a level above which liq rate explodes and net PnL flips negative
  // (v1+v2 history, ≤24h-to-resolution; see
  // .claude/rules/bucket-bot-framework.md). Defaults sit just below the cliff:
  // max volume while staying near break-even.
  //   0.90-0.95 → 4x  (cliff at 5)
  //   0.95-0.97 → 5x  (cliff at 6)
  //   0.97-0.99 → 8x  (cliff at 9; lev 8 = most volume AND profitable)
  //   0.99+     → 10x (no cliff: 0% liq, profitable, max volume)
  //
  // 0.97+ was historically a single bucket; we now split at 0.99 so a more
  // confident leverage can sit on top of the 0.99+ band. `LEVERAGE_97_PLUS`
  // remains an optional legacy override for both upper buckets so existing bot
  // envs that only set the legacy var don't break.
  const lev90 = Number(process.env.LEVERAGE_90_95 ?? 4);
  const lev95 = Number(process.env.LEVERAGE_95_97 ?? 5);
  const lev97plusLegacy = process.env.LEVERAGE_97_PLUS;
  const lev97_99 = Number(process.env.LEVERAGE_97_99 ?? lev97plusLegacy ?? 8);
  const lev99 = Number(process.env.LEVERAGE_99_PLUS ?? lev97plusLegacy ?? 10);
  for (const [envName, v] of Object.entries({
    LEVERAGE_90_95: lev90,
    LEVERAGE_95_97: lev95,
    LEVERAGE_97_99: lev97_99,
    LEVERAGE_99_PLUS: lev99,
  })) {
    if (!(Number.isInteger(v) && v >= 1 && v <= 100))
      throw new Error(`${envName} must be an integer in [1, 100], got ${v}`);
  }

  const collateralFloorUsd = Number(process.env.COLLATERAL_FLOOR_USD ?? 1);
  if (!(collateralFloorUsd >= 1))
    throw new Error("COLLATERAL_FLOOR_USD must be >= 1 (CLOB minimum)");

  const maker: MakerConfig = {
    maxRestingAgeMs:
      Number(process.env.MAKER_MAX_RESTING_AGE_SEC ?? 600) * 1000,
    maxRepricesPerSlot: Number(process.env.MAKER_MAX_REPRICES_PER_SLOT ?? 5),
    defaultTickSize: Number(process.env.MAKER_DEFAULT_TICK_SIZE ?? 0.001),
  };
  if (!(maker.maxRestingAgeMs >= 60_000))
    throw new Error(
      "MAKER_MAX_RESTING_AGE_SEC must be >= 60 (don't reprice faster than the bot polls)",
    );
  if (
    !(
      Number.isInteger(maker.maxRepricesPerSlot) &&
      maker.maxRepricesPerSlot >= 0
    )
  )
    throw new Error(
      "MAKER_MAX_REPRICES_PER_SLOT must be a non-negative integer",
    );
  if (!(maker.defaultTickSize > 0 && maker.defaultTickSize <= 0.01))
    throw new Error("MAKER_DEFAULT_TICK_SIZE must be in (0, 0.01]");

  const tpRoeRaw = process.env.TP_ROE_PCT?.trim();
  let tpRoePct: number | undefined;
  if (tpRoeRaw && tpRoeRaw.length > 0) {
    const parsed = Number(tpRoeRaw);
    if (!(Number.isFinite(parsed) && parsed > 0))
      throw new Error("TP_ROE_PCT must be a positive number");
    tpRoePct = parsed;
  }

  const tpActiveExit =
    (process.env.TP_ACTIVE_EXIT ?? "false").toLowerCase() === "true";

  // Hours-to-resolution gates (global default + per-bucket overrides).
  // `MAX_HOURS_TO_RESOLUTION` / `MIN_HOURS_TO_RESOLUTION` set every bucket's
  // default; `MAX_HOURS_97_99`, `MIN_HOURS_90_95`, … override per bucket.
  // Empirically the deep 0.97-0.99 bucket only profits opened ≤~18h out while
  // shallow buckets tolerate ≤24h, so the gate is bucket-specific. See
  // .claude/rules/bucket-bot-framework.md.
  const parseHours = (name: string): number | undefined => {
    const raw = process.env[name]?.trim();
    if (!raw || raw.length === 0) return undefined;
    const v = Number(raw);
    if (!(Number.isFinite(v) && v > 0))
      throw new Error(`${name} must be a positive number`);
    return v;
  };
  const globalMaxHours = parseHours("MAX_HOURS_TO_RESOLUTION");
  const globalMinHours = parseHours("MIN_HOURS_TO_RESOLUTION");
  const maxHoursPerBucket: HoursPerBucket = {
    "0.90-0.95": parseHours("MAX_HOURS_90_95") ?? globalMaxHours,
    "0.95-0.97": parseHours("MAX_HOURS_95_97") ?? globalMaxHours,
    "0.97-0.99": parseHours("MAX_HOURS_97_99") ?? globalMaxHours,
    "0.99+": parseHours("MAX_HOURS_99_PLUS") ?? globalMaxHours,
  };
  const minHoursPerBucket: HoursPerBucket = {
    "0.90-0.95": parseHours("MIN_HOURS_90_95") ?? globalMinHours,
    "0.95-0.97": parseHours("MIN_HOURS_95_97") ?? globalMinHours,
    "0.97-0.99": parseHours("MIN_HOURS_97_99") ?? globalMinHours,
    "0.99+": parseHours("MIN_HOURS_99_PLUS") ?? globalMinHours,
  };
  for (const b of ["0.90-0.95", "0.95-0.97", "0.97-0.99", "0.99+"] as const) {
    const mn = minHoursPerBucket[b];
    const mx = maxHoursPerBucket[b];
    if (mn !== undefined && mx !== undefined && mn >= mx)
      throw new Error(
        `MIN hours (${mn}) must be < MAX hours (${mx}) for bucket ${b}`,
      );
  }
  // Coarse, event-level cutoff = the loosest per-bucket bound. The event
  // pre-filter drops whole events beyond what ANY bucket would accept, so it
  // must never drop an event some bucket could still trade. An uncapped bucket
  // = infinite horizon, so if ANY bucket has no cap the loosest bound is
  // infinite ⇒ no event-level drop (undefined); the allocator still applies
  // each capped bucket's precise cap per strike. Only when ALL buckets are
  // capped is the coarse cutoff the finite max of those caps.
  const allBucketsCapped = Object.values(maxHoursPerBucket).every(
    (v) => v !== undefined,
  );
  const maxHoursToResolution = allBucketsCapped
    ? Math.max(...(Object.values(maxHoursPerBucket) as number[]))
    : undefined;

  const maxEntryRaw = process.env.MAX_ENTRY_PRICE?.trim();
  let maxEntryPrice: number | undefined;
  if (maxEntryRaw && maxEntryRaw.length > 0) {
    const parsed = Number(maxEntryRaw);
    if (!(Number.isFinite(parsed) && parsed > 0 && parsed <= 1))
      throw new Error("MAX_ENTRY_PRICE must be in (0, 1]");
    maxEntryPrice = parsed;
  }

  const minRoiRaw = process.env.MIN_ROI_AFTER_INTEREST_PCT?.trim();
  let minRoiAfterInterestPct: number | undefined;
  if (minRoiRaw && minRoiRaw.length > 0) {
    const parsed = Number(minRoiRaw);
    if (!Number.isFinite(parsed))
      throw new Error("MIN_ROI_AFTER_INTEREST_PCT must be a finite number");
    minRoiAfterInterestPct = parsed;
  }

  const poolRaw = process.env.LENDING_POOL_ADDRESS?.trim();
  let lendingPoolAddress: Address | undefined;
  if (poolRaw && poolRaw.length > 0) {
    if (!isAddress(poolRaw))
      throw new Error(
        `LENDING_POOL_ADDRESS is not a valid address: ${poolRaw}`,
      );
    lendingPoolAddress = getAddress(poolRaw);
  }
  if (minRoiAfterInterestPct !== undefined && !lendingPoolAddress) {
    throw new Error(
      "MIN_ROI_AFTER_INTEREST_PCT requires LENDING_POOL_ADDRESS to be set (the ROI gate reads live borrowRate from the pool).",
    );
  }

  const polygonRpcRaw = process.env.POLYGON_RPC_URL?.trim();
  const polygonRpcUrl =
    polygonRpcRaw && polygonRpcRaw.length > 0 ? polygonRpcRaw : undefined;

  const stabilityRaw = process.env.BUCKET_STABILITY_WINDOW_MIN?.trim();
  let bucketStabilityWindowMin: number | undefined;
  if (stabilityRaw && stabilityRaw.length > 0) {
    const parsed = Number(stabilityRaw);
    if (!(Number.isFinite(parsed) && parsed > 0))
      throw new Error("BUCKET_STABILITY_WINDOW_MIN must be a positive number");
    bucketStabilityWindowMin = parsed;
  }

  const maxPosRaw = process.env.MAX_POSITION_COLLATERAL_USD?.trim();
  let maxPositionCollateralUsd: number | undefined;
  if (maxPosRaw && maxPosRaw.length > 0) {
    const parsed = Number(maxPosRaw);
    if (!(Number.isFinite(parsed) && parsed > 0))
      throw new Error("MAX_POSITION_COLLATERAL_USD must be a positive number");
    maxPositionCollateralUsd = parsed;
  }

  const orderMode = parseOrderMode(process.env.ORDER_MODE);

  // Optional anti-volatility open-gate. Default-off; rules default to the dual
  // 15m>0.8% OR 4h>2.0% gate but are fully configurable via VOL_GATE_RULES.
  const volGateEnabled =
    (process.env.VOL_GATE_ENABLED ?? "false").toLowerCase() === "true";
  const volRules = parseVolRules(process.env.VOL_GATE_RULES);
  const btcVolPollMs = Number(process.env.BTC_VOL_POLL_MS ?? 20_000);
  if (!(Number.isFinite(btcVolPollMs) && btcVolPollMs > 0))
    throw new Error("BTC_VOL_POLL_MS must be a positive number");
  const reentryRaw = process.env.REENTRY_COOLDOWN_MS?.trim();
  let reentryCooldownMs: number | undefined;
  if (reentryRaw && reentryRaw.length > 0) {
    const parsed = Number(reentryRaw);
    if (!(Number.isFinite(parsed) && parsed >= 0))
      throw new Error("REENTRY_COOLDOWN_MS must be a number >= 0");
    reentryCooldownMs = parsed;
  }

  // Server-side stop-loss (default off). Fraction validated in (0, 1) by
  // parseStopFraction so a misconfig fails at startup, not silently.
  const stopLossEnabled =
    (process.env.STOP_LOSS_ENABLED ?? "false").toLowerCase() === "true";
  const stopLossMarginFraction = parseStopFraction(
    process.env.STOP_LOSS_MARGIN_FRACTION,
  );

  return {
    apiBase: req("AMPLIFI_API_BASE").replace(/\/$/, ""),
    botPrivateKey,
    botAddress: getAddress(rawBot),
    totalCapitalUsd,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 60_000),
    days,
    btcDailySeriesId,
    dayWeights,
    allowedBuckets,
    leveragePerBucket: {
      "0.90-0.95": lev90,
      "0.95-0.97": lev95,
      "0.97-0.99": lev97_99,
      "0.99+": lev99,
    },
    restricted:
      (process.env.ABOVE_BELOW_RESTRICTED ?? "false").toLowerCase() === "true",
    dryRun,
    stateFile:
      stateFileEnv && stateFileEnv.length > 0 ? stateFileEnv : defaultStateFile,
    collateralFloorUsd,
    maker,
    tpRoePct,
    tpActiveExit,
    maxHoursToResolution,
    maxHoursPerBucket,
    minHoursPerBucket,
    maxEntryPrice,
    minRoiAfterInterestPct,
    lendingPoolAddress,
    polygonRpcUrl,
    bucketStabilityWindowMin,
    maxPositionCollateralUsd,
    orderMode,
    volGateEnabled,
    volRules,
    btcVolPollMs,
    reentryCooldownMs,
    stopLossEnabled,
    stopLossMarginFraction,
  };
}
