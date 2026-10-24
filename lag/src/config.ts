import type { Hex } from "viem";
import type { SignalConfig } from "./signal.ts";

export interface LagConfig {
  dryRun: boolean;
  /** Required only when DRY_RUN=false. Read from the environment, never logged. */
  privateKey: Hex | null;
  polygonRpcUrl: string | null;
  signal: SignalConfig;
  /** Only strikes resolving within this many hours; the backtest covered 72. */
  maxHoursLeft: number;
  /** Stop opening this close to resolution. */
  minSecondsLeft: number;
  maxTradeUsd: number;
  maxStrikeUsd: number;
  /** Cap on collateral in unresolved positions across all strikes. */
  maxOpenUsd: number;
  /** Skip signals whose Binance price is older than this. */
  maxSpotAgeMs: number;
  stateFile: string;
  journalFile: string;
}

function num(env: Record<string, string | undefined>, name: string, dflt: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

export function loadLagConfig(env: Record<string, string | undefined> = process.env): LagConfig {
  const dryRun = env.DRY_RUN !== "false";
  const key = env.LAG_PRIVATE_KEY?.trim();
  if (!dryRun && !/^0x[0-9a-fA-F]{64}$/.test(key ?? ""))
    throw new Error("DRY_RUN=false requires LAG_PRIVATE_KEY (0x + 64 hex)");
  if (!dryRun && !env.POLYGON_RPC_URL) throw new Error("DRY_RUN=false requires POLYGON_RPC_URL");
  const signal: SignalConfig = {
    margin: num(env, "LAG_MARGIN", 0.01),
    halfLifeSec: num(env, "LAG_BASIS_HALF_LIFE_SEC", 60),
    cooldownSec: num(env, "LAG_COOLDOWN_SEC", 60),
    minPrice: num(env, "LAG_MIN_PRICE", 0.9),
    maxPrice: num(env, "LAG_MAX_PRICE", 0.99),
    takerFeeRate: num(env, "LAG_TAKER_FEE_RATE", 0.07),
  };
  if (!(signal.halfLifeSec > 0)) throw new Error("LAG_BASIS_HALF_LIFE_SEC must be > 0");
  if (!(signal.minPrice < signal.maxPrice)) throw new Error("LAG_MIN_PRICE must be below LAG_MAX_PRICE");
  const mode = dryRun ? "dry" : "live";
  return {
    dryRun,
    privateKey: dryRun ? null : (key as Hex),
    polygonRpcUrl: env.POLYGON_RPC_URL ?? null,
    signal,
    maxHoursLeft: num(env, "LAG_MAX_HOURS_LEFT", 72),
    minSecondsLeft: num(env, "LAG_MIN_SECONDS_LEFT", 30),
    maxTradeUsd: num(env, "LAG_MAX_TRADE_USD", 20),
    maxStrikeUsd: num(env, "LAG_MAX_STRIKE_USD", 60),
    maxOpenUsd: num(env, "LAG_MAX_OPEN_USD", 300),
    maxSpotAgeMs: num(env, "LAG_MAX_SPOT_AGE_MS", 2000),
    stateFile: env.LAG_STATE_FILE ?? `lag/.state.${mode}.json`,
    journalFile: env.LAG_JOURNAL_FILE ?? `lag/journal.${mode}.jsonl`,
  };
}
