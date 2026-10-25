/**
 * Positions are held to resolution. Once Gamma reports a strike closed with a
 * 1/0 outcome, paper positions are marked settled; live ones are first
 * redeemed for pUSD through the Conditional Tokens contract.
 */
import { getContractConfig } from "@polymarket/clob-client-v2";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  zeroHash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { fetchWithTimeout } from "../../common/src/http.ts";
import { parseStringArray } from "../../common/src/gamma.ts";
import type { Side } from "./signal.ts";

export interface Position {
  slug: string;
  conditionId: string;
  tokenId: string;
  side: Side;
  strikeUsd: number;
  endMs: number;
  shares: number;
  cost: number;
  fee: number;
  openedAtMs: number;
  fair: number;
  edge: number;
  /** $ per share at resolution: 1 or 0. */
  payout?: number;
  settledAtMs?: number;
}

export function positionPnl(p: Position): number | null {
  return p.payout === undefined ? null : p.payout * p.shares - p.cost - p.fee;
}

/** YES payout per share from a closed Gamma market, or null if unresolved. */
export function resolvedYesPayout(m: { closed?: boolean; outcomePrices?: string }): number | null {
  if (!m.closed) return null;
  const prices = parseStringArray(m.outcomePrices)?.map(Number);
  if (prices?.length !== 2) return null;
  if (prices[0] === 1 && prices[1] === 0) return 1;
  if (prices[0] === 0 && prices[1] === 1) return 0;
  return null;
}

export async function fetchResolvedYesPayouts(conditionIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < conditionIds.length; i += 20) {
    const ids = conditionIds.slice(i, i + 20).map((c) => `condition_ids=${c}`).join("&");
    const res = await fetchWithTimeout(
      `https://gamma-api.polymarket.com/markets?closed=true&${ids}`,
    );
    if (!res.ok) throw new Error(`gamma markets ${res.status}`);
    for (const m of (await res.json()) as { conditionId: string; closed: boolean; outcomePrices: string }[]) {
      const yes = resolvedYesPayout(m);
      if (yes !== null) out.set(m.conditionId, yes);
    }
  }
  return out;
}

const CTF_ABI = parseAbi([
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
  "function payoutDenominator(bytes32 conditionId) view returns (uint256)",
]);

export class Redeemer {
  private readonly cfg = getContractConfig(polygon.id);
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;

  constructor(privateKey: Hex, rpcUrl: string) {
    this.account = privateKeyToAccount(privateKey);
    this.publicClient = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: polygon,
      transport: http(rpcUrl),
    });
  }

  /** Redeems both outcome slots of a reported condition. Returns false while
   *  the oracle has not reported on-chain yet, so the caller retries later. */
  async redeem(conditionId: Hex): Promise<boolean> {
    const ctf = this.cfg.conditionalTokens as Hex;
    const denom = await this.publicClient.readContract({
      address: ctf,
      abi: CTF_ABI,
      functionName: "payoutDenominator",
      args: [conditionId],
    });
    if (denom === 0n) return false;
    const hash = await this.walletClient.writeContract({
      address: ctf,
      abi: CTF_ABI,
      functionName: "redeemPositions",
      args: [this.cfg.collateral as Hex, zeroHash, conditionId, [1n, 2n]],
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`redeem reverted: ${hash}`);
    return true;
  }
}
