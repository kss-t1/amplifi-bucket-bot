/**
 * Turns a signal into a fill. Both executors buy at most `usd` worth of the
 * token at or below `limit` and report what actually filled.
 *
 * Live sends a fill-and-kill order capped at the stale price, so a quote that
 * moved before the order landed simply does not fill. Paper re-reads the book
 * over REST at that moment for the same check, standing in for the backtest's
 * "is the quote still there L seconds later" rule.
 */
import {
  Chain,
  ClobClient,
  OrderType,
  Side as ClobSide,
  SignatureTypeV2,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { fetchWithTimeout } from "../../common/src/http.ts";

export interface BuyOrder {
  /** Token being bought. */
  tokenId: string;
  /** The strike's YES token, whose book prices both sides. */
  yesTokenId: string;
  side: "YES" | "NO";
  limit: number;
  /** Paper only: a higher cap to measure against the same book read. */
  probeLimit?: number;
  usd: number;
  tickSize: number;
  negRisk: boolean;
}

export interface Fill {
  shares: number;
  /** Collateral paid for the shares, excluding the taker fee. */
  cost: number;
  orderId?: string;
}

/** What the book offered when the order went in, for sizing the strategy. */
export interface Depth {
  /** Every share at or under the limit, ignoring the trade's dollar cap. */
  atLimit: Fill | null;
  /** The same at `probeLimit`. */
  atProbe: Fill | null;
  /** The fill the trade would have got at `probeLimit`. */
  probeFill: Fill | null;
}

export interface BuyResult {
  fill: Fill | null;
  /** Paper only; live sees nothing but its own fill. */
  depth?: Depth;
}

export interface Executor {
  readonly live: boolean;
  warm(tokenIds: string[]): Promise<void>;
  buy(order: BuyOrder): Promise<BuyResult>;
}

const CLOB = "https://clob.polymarket.com";

interface Level {
  price: string;
  size: string;
}

/** Shares a buy of `usd` capped at `limit` takes from an ask ladder. */
export function walkAsks(asks: Level[], limit: number, usd: number): Fill | null {
  const levels = asks
    .map((l) => ({ price: Number(l.price), size: Number(l.size) }))
    .filter((l) => l.size > 0 && l.price <= limit + 1e-9)
    .sort((a, b) => a.price - b.price);
  let budget = usd;
  let shares = 0;
  let cost = 0;
  for (const l of levels) {
    const take = Math.min(l.size, budget / l.price);
    shares += take;
    cost += take * l.price;
    budget -= take * l.price;
    if (budget <= 1e-9) break;
  }
  return shares > 0 ? { shares, cost } : null;
}

export class PaperExecutor implements Executor {
  readonly live = false;

  async warm(): Promise<void> {}

  /** Reads the YES book like the backtest did: NO is offered at 1 − YES bid. */
  async buy(order: BuyOrder): Promise<BuyResult> {
    const res = await fetchWithTimeout(`${CLOB}/book?token_id=${order.yesTokenId}`, {}, 5_000);
    if (!res.ok) throw new Error(`book ${res.status}`);
    const book = (await res.json()) as { bids?: Level[]; asks?: Level[] };
    const asks =
      order.side === "YES"
        ? (book.asks ?? [])
        : (book.bids ?? []).map((l) => ({ price: String(1 - Number(l.price)), size: l.size }));
    const probe = order.probeLimit ?? order.limit;
    return {
      fill: walkAsks(asks, order.limit, order.usd),
      depth: {
        atLimit: walkAsks(asks, order.limit, Infinity),
        atProbe: walkAsks(asks, probe, Infinity),
        probeFill: walkAsks(asks, probe, order.usd),
      },
    };
  }
}

/** Fields of a CLOB post-order response the bot reads. */
export interface PostOrderResponse {
  success?: boolean;
  status?: string;
  orderID?: string;
  makingAmount?: string;
  takingAmount?: string;
  error?: string;
  errorMsg?: string;
}

/** A BUY's making amount is collateral paid, its taking amount is shares. */
export function fillFromResponse(r: PostOrderResponse): Fill | null {
  if (!r || r.success === false || r.error || r.errorMsg) return null;
  const shares = Number(r.takingAmount);
  const cost = Number(r.makingAmount);
  if (!(shares > 0) || !(cost > 0)) return null;
  return { shares, cost, orderId: r.orderID };
}

export class LiveExecutor implements Executor {
  readonly live = true;
  private client: ClobClient | null = null;

  constructor(private readonly privateKey: Hex) {}

  /** Derives CLOB API credentials from the key; nothing is stored on disk. */
  async init(): Promise<void> {
    const account = privateKeyToAccount(this.privateKey);
    const signer = createWalletClient({ account, chain: polygon, transport: http() });
    const l1 = new ClobClient({ host: CLOB, chain: Chain.POLYGON, signer });
    const creds = await l1.createOrDeriveApiKey();
    this.client = new ClobClient({
      host: CLOB,
      chain: Chain.POLYGON,
      signer,
      creds,
      signatureType: SignatureTypeV2.EOA,
      funderAddress: account.address,
    });
  }

  /** The client looks up per-token market info on its first order for a
   *  token; doing that ahead of time keeps it off the latency path. */
  async warm(tokenIds: string[]): Promise<void> {
    const c = this.requireClient();
    await c.getVersion();
    for (const id of tokenIds) await c.getFeeExponent(id);
  }

  async buy(order: BuyOrder): Promise<BuyResult> {
    const c = this.requireClient();
    const tickSize = String(order.tickSize) as "0.1" | "0.01" | "0.001" | "0.0001";
    const post = () =>
      c.createAndPostMarketOrder(
        {
          tokenID: order.tokenId,
          price: order.limit,
          amount: Math.floor(order.usd * 100) / 100,
          side: ClobSide.BUY,
          orderType: OrderType.FAK,
        },
        { tickSize, negRisk: order.negRisk },
        OrderType.FAK,
      );
    try {
      return { fill: fillFromResponse((await post()) as PostOrderResponse) };
    } catch (err) {
      // Polymarket narrows a market's tick as its price nears 0 or 1, and the
      // client caches the old one forever. Drop it and retry once.
      if (!/tick size/i.test(String(err))) throw err;
      delete (c.tickSizes as Record<string, unknown>)[order.tokenId];
      return { fill: fillFromResponse((await post()) as PostOrderResponse) };
    }
  }

  private requireClient(): ClobClient {
    if (!this.client) throw new Error("LiveExecutor.init() not called");
    return this.client;
  }
}
