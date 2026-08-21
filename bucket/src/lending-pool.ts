/**
 * Reads the live `borrowRate` (bps) from an `AmplifiLendingPool` on Polygon
 * and caches the result for a short TTL. Used by the bucket bot's ROI gate
 * to decide whether the upside left in a near-resolution market beats the
 * interest cost of holding the borrowed leverage to expiry.
 *
 * Intentionally minimal — the backend's full `LendingPoolClient` pulls in
 * Logger/retry/SQL deps the bot doesn't need. We just want one read of
 * `borrowRate()` against the configured pool address.
 */
import {
  type Address,
  type PublicClient,
  createPublicClient,
  http,
} from "viem";
import { polygon } from "viem/chains";
import type { Logger } from "../../common/src/amplifi-client.ts";

const POOL_BORROW_RATE_ABI = [
  {
    type: "function",
    name: "borrowRate",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export interface LendingPoolReaderConfig {
  poolAddress: Address;
  rpcUrl?: string;
  /** Cache TTL. Default 5 min — borrow rate moves slowly relative to a
   *  bot that polls once a minute. */
  cacheTtlMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class LendingPoolReader {
  private client: PublicClient;
  private cache: { aprDecimal: number; ts: number } | null = null;
  private readonly ttlMs: number;

  constructor(
    private readonly cfg: LendingPoolReaderConfig,
    private readonly logger: Logger,
  ) {
    this.client = createPublicClient({
      chain: polygon,
      transport: http(cfg.rpcUrl ?? "https://polygon-rpc.com"),
    });
    this.ttlMs = cfg.cacheTtlMs ?? DEFAULT_TTL_MS;
  }

  /** Live APR as a decimal (0.30 = 30%). Cached for `ttlMs`. Throws on RPC
   *  failure — caller decides whether to fail-closed or skip the ROI gate. */
  async getAprDecimal(): Promise<number> {
    const now = Date.now();
    if (this.cache && now - this.cache.ts < this.ttlMs) {
      return this.cache.aprDecimal;
    }
    const raw = (await this.client.readContract({
      address: this.cfg.poolAddress,
      abi: POOL_BORROW_RATE_ABI,
      functionName: "borrowRate",
    })) as bigint;
    const bps = Number(raw);
    if (!Number.isFinite(bps) || bps < 0) {
      throw new Error(`borrowRate returned unreasonable value: ${raw}`);
    }
    const aprDecimal = bps / 10_000;
    this.cache = { aprDecimal, ts: now };
    this.logger.info("lending pool borrow rate", {
      pool: this.cfg.poolAddress,
      aprBps: bps,
      aprPct: (aprDecimal * 100).toFixed(2),
    });
    return aprDecimal;
  }
}

/**
 * Expected ROI on collateral if a leveraged long held to resolution and the
 * qualifying side wins (resolves at $1). All inputs are decimals.
 *
 *   payoff(C)     = L·C / p       (shares × $1)
 *   loan_repay(C) = (L−1)·C · (1 + apr · t)
 *   roi(C)        = payoff − loan_repay − C
 *                 = C · [ L·(1−p)/p − (L−1)·apr·t ]
 *
 * Returns the bracketed expression — ROI per dollar of collateral.
 */
export function expectedRoiOnCollateral(args: {
  entryPrice: number;
  leverage: number;
  aprDecimal: number;
  hoursToResolution: number;
}): number {
  const { entryPrice: p, leverage: L, aprDecimal, hoursToResolution } = args;
  const years = hoursToResolution / (24 * 365);
  const upside = (L * (1 - p)) / p;
  const interest = (L - 1) * aprDecimal * years;
  return upside - interest;
}
