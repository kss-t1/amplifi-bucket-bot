/**
 * Generic BTC volatility open-gate, shared across bot profiles.
 *
 * A gate is a LIST of rules, each `{ window, thresholdPct }`. It BLOCKS opening
 * a new position when the ABSOLUTE % move of BTC spot over ANY rule's trailing
 * window exceeds that rule's threshold. This catches both failure shapes seen
 * live: a sharp spike trips a short-window rule (e.g. 15m > 0.8%); a slow grind
 * that keeps any single 15m move small still trips a long-window rule
 * (e.g. 4h > 2.0%). Fully configurable — any number of windows/thresholds.
 *
 * Metric = absolute fractional move `|price_now / price_(now−window) − 1|`
 * (directional drift magnitude), NOT std-dev realized vol. (The btc15m bot uses
 * a complementary std-dev "calm-only" gate in `bots/btc15m/src/btc-vol.ts`;
 * this module is the drift-magnitude block-gate and is metric-independent in
 * spirit — a std-dev rule type could be added here later if a profile needs it.)
 *
 * Price source: seed the buffer from Binance 5m klines on startup (so long
 * windows are warm from the first tick) then append live spot polls. All gate
 * math lives in pure exported helpers so it is unit-testable without network.
 * Fetch failures fail-OPEN (a null move never blocks) so a Binance hiccup never
 * wedges a bot — matching the rest of the bots' "never trade blind, but never
 * crash on a feed blip" posture.
 */

export interface VolLogger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
}

export interface PricePoint {
  ts: number; // epoch ms
  price: number;
}

/** One gate rule: block if |move over `windowMs`| exceeds `thresholdPct` %.
 *  When `directional`, only the side the move HURTS is blocked — a rise blocks
 *  NO, a fall blocks YES. */
export interface VolRule {
  label: string;
  windowMs: number;
  thresholdPct: number;
  directional?: boolean;
}

/** The side of a binary market an open would take. */
export type PositionSide = "YES" | "NO";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Default gate: 15m > 0.8% OR 4h > 2.0% (the dual gate calibrated on live data). */
export const DEFAULT_VOL_RULES: VolRule[] = [
  { label: "15m", windowMs: 15 * MIN, thresholdPct: 0.8 },
  { label: "4h", windowMs: 4 * HOUR, thresholdPct: 2.0 },
];

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: MIN,
  h: HOUR,
  d: 24 * HOUR,
};

/**
 * Parse a flexible rules spec like `"15m:0.8,4h:2.0,1d:5"` into VolRule[].
 * Each token is `WINDOW:THRESHOLD_PCT`; WINDOW is `<number><s|m|h|d>`. Empty /
 * undefined → DEFAULT_VOL_RULES. Throws on a malformed token so misconfig fails
 * loudly at startup rather than silently disabling protection.
 */
export function parseVolRules(spec: string | undefined): VolRule[] {
  if (spec === undefined || spec.trim().length === 0) return DEFAULT_VOL_RULES;
  const rules: VolRule[] = [];
  for (const raw of spec.split(",")) {
    const tok = raw.trim();
    if (!tok) continue;
    const m = tok.match(
      /^(\d+(?:\.\d+)?)\s*([smhd])\s*:\s*(\d+(?:\.\d+)?)\s*(?::\s*(dir))?$/i,
    );
    if (!m)
      throw new Error(
        `VOL_GATE_RULES token "${tok}" is malformed; expected "<n><s|m|h|d>:<pct>[:dir]", e.g. "15m:0.8" or "48h:5:dir"`,
      );
    const qty = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    const pct = Number(m[3]);
    const windowMs = qty * UNIT_MS[unit]!;
    if (!(windowMs > 0))
      throw new Error(`VOL_GATE_RULES: window must be > 0 ("${tok}")`);
    if (!(pct > 0 && pct <= 100))
      throw new Error(
        `VOL_GATE_RULES: threshold must be in (0,100] ("${tok}")`,
      );
    const directional = m[4] !== undefined;
    rules.push({
      label: `${m[1]}${unit}${directional ? ":dir" : ""}`,
      windowMs,
      thresholdPct: pct,
      ...(directional ? { directional: true } : {}),
    });
  }
  if (rules.length === 0) return DEFAULT_VOL_RULES;
  return rules;
}

/** Latest buffered price at or before `ts` (buffer must be ascending by ts). */
export function priceAtOrBefore(
  buffer: PricePoint[],
  ts: number,
): number | null {
  let found: number | null = null;
  for (const p of buffer) {
    if (p.ts <= ts) found = p.price;
    else break;
  }
  return found;
}

/**
 * Absolute fractional move over the trailing `windowMs`, anchored on the most
 * recent buffered price. null if the buffer doesn't reach back far enough to
 * cover the window (warm-up) or is empty.
 */
export function absMove(buffer: PricePoint[], windowMs: number): number | null {
  if (buffer.length === 0) return null;
  const last = buffer[buffer.length - 1]!;
  const earliest = buffer[0]!;
  if (last.ts - earliest.ts < windowMs) return null; // not warm yet
  const past = priceAtOrBefore(buffer, last.ts - windowMs);
  if (past === null || past <= 0) return null;
  return Math.abs(last.price / past - 1);
}

/**
 * Signed fractional move over the trailing `windowMs` (positive = BTC rose).
 * Same warm-up semantics as `absMove`.
 */
export function signedMove(
  buffer: PricePoint[],
  windowMs: number,
): number | null {
  if (buffer.length === 0) return null;
  const last = buffer[buffer.length - 1]!;
  const earliest = buffer[0]!;
  if (last.ts - earliest.ts < windowMs) return null;
  const past = priceAtOrBefore(buffer, last.ts - windowMs);
  if (past === null || past <= 0) return null;
  return last.price / past - 1;
}

/** True when a signed BTC move works against `side`. */
export function moveHurts(move: number, side: PositionSide): boolean {
  return side === "NO" ? move > 0 : move < 0;
}

export interface GateDecision {
  block: boolean;
  /** Rules whose move exceeded threshold (empty if not blocking). */
  breaches: { label: string; movePct: number; thresholdPct: number }[];
  /** Per-rule move (%) for logging; null = warm-up. */
  moves: Record<string, number | null>;
}

/**
 * Pure gate evaluation over a price buffer. Blocks if ANY rule breaches.
 * A directional rule breaches only when the move hurts `side`; with no `side`
 * it falls back to the absolute test, so a caller that cannot name a side is
 * never left unprotected.
 */
export function evaluateRules(
  buffer: PricePoint[],
  rules: VolRule[],
  side?: PositionSide,
): GateDecision {
  const breaches: GateDecision["breaches"] = [];
  const moves: Record<string, number | null> = {};
  for (const r of rules) {
    const signed = signedMove(buffer, r.windowMs);
    const m = signed === null ? null : Math.abs(signed);
    moves[r.label] = m === null ? null : m * 100;
    if (m === null || m * 100 <= r.thresholdPct) continue;
    if (r.directional && side !== undefined && !moveHurts(signed!, side))
      continue;
    breaches.push({
      label: r.label,
      movePct: m * 100,
      thresholdPct: r.thresholdPct,
    });
  }
  return { block: breaches.length > 0, breaches, moves };
}

const BINANCE = "https://api.binance.com/api/v3";

/**
 * Live BTC vol gate: holds a price buffer (seeded from klines + spot polls) and
 * evaluates a configurable rule list. Construct once per bot, `await seed()`
 * before the loop, `await poll()` each tick, `evaluate()` before each open.
 */
export class BtcVolGate {
  private buffer: PricePoint[] = [];
  private lastPollMs = 0;
  private readonly keepMs: number;

  constructor(
    private readonly rules: VolRule[],
    private readonly pollIntervalMs: number,
    private readonly logger: VolLogger,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const maxWindow = rules.reduce((mx, r) => Math.max(mx, r.windowMs), 0);
    this.keepMs = Math.max(maxWindow * 1.25, 30 * MIN);
  }

  /** Seed the buffer from 5m klines so long-window rules are warm immediately. */
  async seed(): Promise<void> {
    const candles = Math.min(1000, Math.ceil(this.keepMs / (5 * MIN)) + 2);
    try {
      const res = await this.fetchImpl(
        `${BINANCE}/klines?symbol=BTCUSDT&interval=5m&limit=${candles}`,
      );
      if (!res.ok) throw new Error(`klines ${res.status}`);
      const rows = (await res.json()) as unknown[][];
      // Pair each candle's CLOSE price with its CLOSE time (r[6]), not its open
      // time (r[0]) — otherwise every seeded point is mislabeled by one
      // interval, skewing short-window (e.g. 15m) moves until live spot polls
      // replace the seed.
      this.buffer = rows
        .map((r) => ({ ts: Number(r[6]), price: Number(r[4]) }))
        .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.price))
        .sort((a, b) => a.ts - b.ts);
      this.logger.info("vol-gate seeded", {
        rules: this.rules.map((r) => `${r.label}:${r.thresholdPct}%`).join(","),
        points: this.buffer.length,
      });
    } catch (err) {
      this.logger.warn("vol-gate seed failed (fail-open until warm)", err);
    }
  }

  /** Throttled spot poll; appends a fresh price and trims old points. */
  async poll(): Promise<void> {
    const t = this.now();
    if (t - this.lastPollMs < this.pollIntervalMs) return;
    this.lastPollMs = t;
    try {
      const res = await this.fetchImpl(
        `${BINANCE}/ticker/price?symbol=BTCUSDT`,
      );
      if (!res.ok) throw new Error(`ticker ${res.status}`);
      const data = (await res.json()) as { price: string };
      const price = Number(data.price);
      if (!Number.isFinite(price) || price <= 0) return;
      this.buffer.push({ ts: t, price });
      const cutoff = t - this.keepMs;
      if (this.buffer[0] && this.buffer[0].ts < cutoff)
        this.buffer = this.buffer.filter((p) => p.ts >= cutoff);
    } catch (err) {
      this.logger.warn("vol-gate poll failed", err);
    }
  }

  /** Current gate decision against the configured rules, for one side. */
  evaluate(side?: PositionSide): GateDecision {
    return evaluateRules(this.buffer, this.rules, side);
  }

  describeRules(): string {
    return this.rules
      .map(
        (r) =>
          `${r.label}>${r.thresholdPct}%${r.directional ? " (hurt side only)" : ""}`,
      )
      .join(" OR ");
  }
}
