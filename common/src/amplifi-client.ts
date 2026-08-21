/**
 * Thin Amplifi API client + EIP-712 intent signer, shared by all bots.
 *
 * Intentionally not reusing `tests/stress/api-client.ts` or `IntentSigner`
 * — those drag in WalletManager / Reporter / TestEoa shapes that are
 * irrelevant here. Covers: deposit, balance, markets, market-order opens
 * + closes, AND the order-first limit-order flow (session, placeLimitOrder,
 * cancelOrder, setTakeProfit, deleteTakeProfit) used by the harvester bot.
 */
import {
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  http,
  parseUnits,
  pad,
  toHex,
  hexToNumber,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import {
  OPEN_POSITION_TYPES,
  CLOSE_POSITION_TYPES,
  MERGE_POSITIONS_TYPES,
  TRADING_SESSION_TYPES,
} from "./eip712.ts";
import { fetchWithTimeout } from "./http.ts";

/** Timeout for endpoints that do on-chain work server-side before replying
 *  (borrow + disbursement + relayer batch + CLOB post). The default 15s
 *  FETCH_TIMEOUT_MS aborts the CLIENT while the server keeps going — the
 *  order/position lands anyway and the bot orphans it (never learns the id).
 *  Seen live on the direct-routing pool: placeLimitOrder aborted at 15s,
 *  order RESTING + loan issued server-side. Mutations wait out the server. */
export const MUTATION_TIMEOUT_MS = 120_000;

const DEPOSIT_INTENT_TYPES = {
  DepositIntent: [
    { name: "userAddress", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const USDC_PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface NonceResponse {
  nonce: number;
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract?: Address;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
}

export interface DepositConfig {
  usdcAddress: Address;
  chainId: number;
  usdcPermitDomain: {
    name: string;
    version: string;
    salt: Hex;
    verifyingContract: Address;
  };
}

export interface OpenPositionResult {
  positionId: number;
  tokenId: string;
  outcome: string;
  sharesAmount: string;
  entryPrice: string;
  liquidationPrice: string;
  status: string;
}

/** Wire shape mirrors `OrderController.OrderResponse`. Numeric fields are
 *  decimal strings to dodge JS float loss; the bot parses what it needs. */
export interface AmplifiOrder {
  id: number;
  userAddress: string;
  tokenId: string;
  side: "YES" | "NO";
  clobSide: "BUY" | "SELL";
  leverage: string;
  margin: string;
  limitPrice: string;
  sharesRequested: string;
  sharesFilled: string;
  avgFillPrice: string | null;
  mainOrderId: string | null;
  status:
    | "PENDING"
    | "RESTING"
    | "PARTIALLY_FILLED"
    | "FILLED"
    | "CANCELED"
    | "FAILED";
  errorMessage: string | null;
  market: string | null;
  marketName: string | null;
  outcome: string | null;
  loanId: number | null;
  positionId: number | null;
  accruedInterest: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AmplifiPosition {
  id: number;
  userAddress: string;
  tokenId: string;
  outcome: "YES" | "NO";
  sharesAmount: string;
  entryPrice: string;
  exitPrice: string | null;
  size: string;
  leverage: string;
  liquidationPrice: string;
  status: string;
  market: string | null;
  createdAt: string;
  updatedAt: string;
  /** How a terminal position closed (e.g. "STOP_LOSS", "LIQUIDATION",
   *  "REDEMPTION"); null/absent on rows predating the column. */
  closeMethod?: string | null;
  /** Server-side stop-loss trigger registered on the position, if any. */
  stopLossPrice?: string | null;
}

export interface TradingSession {
  token: string;
  expiresAt: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
    public method: string,
    public path: string,
  ) {
    super(`API ${method} ${path} -> ${status}: ${body.slice(0, 200)}`);
  }
}

export interface Logger {
  info: (msg: string, data?: unknown) => void;
  warn: (msg: string, data?: unknown) => void;
  error: (msg: string, data?: unknown) => void;
}

export class AmplifiClient {
  private depositConfig: DepositConfig | null = null;
  private safeAddress: Address | null = null;
  private polygonClient: PublicClient;
  private session: TradingSession | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly privateKey: Hex,
    private readonly userAddress: Address,
    private readonly logger: Logger,
    polygonRpcUrl?: string,
  ) {
    // Treat empty string as unset — the .env.example ships with
    // `POLYGON_RPC_URL=` commented out, but a stray uncommented empty
    // value would otherwise produce an `http("")` transport that fails
    // confusingly later when `deposit()` reads the USDC permit nonce.
    const rpcUrl =
      polygonRpcUrl && polygonRpcUrl.trim().length > 0
        ? polygonRpcUrl
        : "https://polygon-rpc.com";
    this.polygonClient = createPublicClient({
      chain: polygon,
      transport: http(rpcUrl),
    });
  }

  private async req<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { withSession?: boolean; timeoutMs?: number },
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (opts?.withSession) {
      if (!this.session) {
        throw new Error(
          `Amplifi ${method} ${path} requires a trading session — call ensureTradingSession() first`,
        );
      }
      headers["x-trading-session"] = this.session.token;
    }
    // Server-side `trySessionAuth` (src/api/controllers/trySessionAuth.ts)
    // reads `sessionToken` from the JSON body, NOT the `x-trading-session`
    // header. Inject the token into the body for session-authed POSTs.
    // The header stays for future endpoints that may prefer it.
    let effectiveBody = body;
    if (opts?.withSession && body && typeof body === "object") {
      effectiveBody = {
        ...(body as Record<string, unknown>),
        sessionToken: this.session!.token,
      };
    }
    const init: RequestInit = { method, headers };
    if (effectiveBody !== undefined) init.body = JSON.stringify(effectiveBody);
    const res = await fetchWithTimeout(
      `${this.baseUrl}${path}`,
      init,
      opts?.timeoutMs,
    );
    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, text, method, path);
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  async health(): Promise<{
    status: string;
    envName?: string;
    gitCommit?: string;
  }> {
    return this.req("GET", "/health");
  }

  async getDepositConfig(): Promise<DepositConfig> {
    if (this.depositConfig) return this.depositConfig;
    this.depositConfig = await this.req<DepositConfig>(
      "GET",
      "/polymarket/deposit-config",
    );
    return this.depositConfig;
  }

  async ensureWallet(): Promise<Address> {
    if (this.safeAddress) return this.safeAddress;
    // The vm018 endpoints return `walletAddress`, NOT `safeAddress`. Verified
    // live against vm018: GET /polymarket/wallet/<addr> returns
    //   { exists, walletAddress, approvalsComplete, ... }
    // POST /polymarket/wallet returns
    //   { walletAddress, approved, clobReady, isNew }
    // Reading the wrong field returns undefined → deposit() signs the USDC
    // permit with `spender=undefined` and the request 400s. The internal
    // `safeAddress` field name stays — it's the right concept locally,
    // just the wire format calls it walletAddress.
    const existing = await this.req<{
      exists: boolean;
      walletAddress?: string;
    }>("GET", `/polymarket/wallet/${this.userAddress}`);
    if (existing.exists && existing.walletAddress) {
      this.safeAddress = existing.walletAddress as Address;
      return this.safeAddress;
    }
    const created = await this.req<{ walletAddress: string }>(
      "POST",
      "/polymarket/wallet",
      { userAddress: this.userAddress },
    );
    this.safeAddress = created.walletAddress as Address;
    this.logger.info("amplifi: created Safe", { safe: this.safeAddress });
    return this.safeAddress;
  }

  async getBalance(): Promise<{
    availableBalance: string;
    availableBalanceFormatted: string;
    totalBalance: string;
    /** Net worth in micro-USDC: safe balance + open-position mark-to-market
     *  − total on-chain debt. Can go negative when debt exceeds assets. */
    equity: string;
    equityFormatted: string;
    hasOpenPosition: boolean;
  }> {
    return this.req("GET", `/polymarket/balance/${this.userAddress}`);
  }

  /** EIP-712 sign + submit a deposit (with USDC.e permit). */
  async deposit(
    amountUsdc: number,
  ): Promise<{ depositId: number; txHash: string }> {
    const cfg = await this.getDepositConfig();
    const safe = await this.ensureWallet();
    const account = privateKeyToAccount(this.privateKey);
    const amount = parseUnits(amountUsdc.toString(), 6);
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const nonceRes = await this.req<NonceResponse>(
      "GET",
      `/polymarket/nonce/${this.userAddress}`,
    );

    const depositSignature = await account.signTypedData({
      domain: nonceRes.domain,
      types: DEPOSIT_INTENT_TYPES,
      primaryType: "DepositIntent",
      message: {
        userAddress: this.userAddress,
        amount,
        nonce: BigInt(nonceRes.nonce),
        deadline: BigInt(deadline),
      },
    });

    // USDC.e EIP-2612 permit (Polygon: salt-based domain).
    const permitNonce = (await this.polygonClient.readContract({
      address: cfg.usdcAddress,
      abi: [
        {
          name: "nonces",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "owner", type: "address" }],
          outputs: [{ name: "", type: "uint256" }],
        },
      ] as const,
      functionName: "nonces",
      args: [this.userAddress],
    })) as bigint;

    const permitSignature = await account.signTypedData({
      domain: cfg.usdcPermitDomain,
      types: USDC_PERMIT_TYPES,
      primaryType: "Permit",
      message: {
        owner: this.userAddress,
        spender: safe,
        value: amount,
        nonce: permitNonce,
        deadline: BigInt(deadline),
      },
    });

    const r = `0x${permitSignature.slice(2, 66)}` as Hex;
    const s = `0x${permitSignature.slice(66, 130)}` as Hex;
    const v = hexToNumber(`0x${permitSignature.slice(130, 132)}`);

    return this.req(
      "POST",
      "/polymarket/deposit",
      {
        userAddress: this.userAddress,
        amount: amount.toString(),
        nonce: nonceRes.nonce,
        deadline,
        signature: depositSignature,
        permit: {
          spender: safe,
          value: amount.toString(),
          deadline,
          v,
          r,
          s,
        },
      },
      { timeoutMs: MUTATION_TIMEOUT_MS },
    );
  }

  /** Sign + submit an open-position intent. */
  async openPosition(args: {
    tokenId: string;
    conditionId: string;
    outcome: "YES" | "NO";
    usdcAmount: string;
    leverage: number;
    slug: string;
  }): Promise<OpenPositionResult> {
    const account = privateKeyToAccount(this.privateKey);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const nonceRes = await this.req<NonceResponse>(
      "GET",
      `/polymarket/positions/nonce/open/${this.userAddress}`,
    );

    const signature = await account.signTypedData({
      domain: nonceRes.domain,
      types: OPEN_POSITION_TYPES,
      primaryType: "OpenPositionIntent",
      message: {
        userAddress: this.userAddress,
        tokenId: pad(toHex(BigInt(args.tokenId)), { size: 32 }),
        outcome: args.outcome,
        usdcAmount: parseUnits(args.usdcAmount, 6),
        leverage: args.leverage,
        nonce: BigInt(nonceRes.nonce),
        deadline: BigInt(deadline),
      },
    });

    return this.req(
      "POST",
      "/polymarket/positions/open",
      {
        userAddress: this.userAddress,
        tokenId: args.tokenId,
        conditionId: args.conditionId,
        outcome: args.outcome,
        usdcAmount: args.usdcAmount,
        leverage: args.leverage.toString(),
        slug: args.slug,
        nonce: nonceRes.nonce,
        deadline,
        signature,
      },
      { timeoutMs: MUTATION_TIMEOUT_MS },
    );
  }

  /** Sign + submit a close-position intent. */
  async closePosition(positionId: number): Promise<{ status: string }> {
    const account = privateKeyToAccount(this.privateKey);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const nonceRes = await this.req<NonceResponse>(
      "GET",
      `/polymarket/positions/nonce/close/${this.userAddress}`,
    );

    const signature = await account.signTypedData({
      domain: nonceRes.domain,
      types: CLOSE_POSITION_TYPES,
      primaryType: "ClosePositionIntent",
      message: {
        userAddress: this.userAddress,
        positionId: BigInt(positionId),
        nonce: BigInt(nonceRes.nonce),
        deadline: BigInt(deadline),
      },
    });

    return this.req(
      "POST",
      `/polymarket/positions/${positionId}/close`,
      {
        userAddress: this.userAddress,
        nonce: nonceRes.nonce,
        deadline,
        signature,
      },
      { timeoutMs: MUTATION_TIMEOUT_MS },
    );
  }

  /**
   * Sign + submit a merge-positions intent: burn the matched portion of a 1×
   * YES+NO pair (min of the two legs) back into collateral. An uneven merge
   * leaves the heavier leg OPEN (reduced shares) — see `residualPositionId`.
   */
  async merge(
    yesPositionId: number,
    noPositionId: number,
  ): Promise<{
    yesPositionId: number;
    noPositionId: number;
    mergedShares: string;
    status: string;
    residualPositionId?: number | null;
    residualShares?: string;
  }> {
    const account = privateKeyToAccount(this.privateKey);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const nonceRes = await this.req<NonceResponse>(
      "GET",
      `/polymarket/positions/nonce/merge/${this.userAddress}`,
    );

    const signature = await account.signTypedData({
      domain: nonceRes.domain,
      types: MERGE_POSITIONS_TYPES,
      primaryType: "MergePositionsIntent",
      message: {
        userAddress: this.userAddress,
        yesPositionId: BigInt(yesPositionId),
        noPositionId: BigInt(noPositionId),
        nonce: BigInt(nonceRes.nonce),
        deadline: BigInt(deadline),
      },
    });

    return this.req(
      "POST",
      "/polymarket/positions/merge",
      {
        userAddress: this.userAddress,
        yesPositionId,
        noPositionId,
        nonce: nonceRes.nonce,
        deadline,
        signature,
      },
      { timeoutMs: MUTATION_TIMEOUT_MS },
    );
  }

  /**
   * Mint a one-click trading session token. Returns cached session if still
   * within `safetyMarginSec` of its expiry. Required for `placeLimitOrder`,
   * `cancelOrder`, `setTakeProfit`, `deleteTakeProfit`.
   */
  async ensureTradingSession(
    durationSeconds: number = 12 * 3600,
    safetyMarginSec: number = 300,
  ): Promise<TradingSession> {
    const now = Math.floor(Date.now() / 1000);
    if (this.session && this.session.expiresAt - now > safetyMarginSec) {
      return this.session;
    }

    const account = privateKeyToAccount(this.privateKey);
    const deadline = now + 3600;
    const nonceRes = await this.req<NonceResponse>(
      "GET",
      `/polymarket/positions/nonce/session/${this.userAddress}`,
    );

    const signature = await account.signTypedData({
      domain: nonceRes.domain,
      types: TRADING_SESSION_TYPES,
      primaryType: "TradingSessionIntent",
      message: {
        userAddress: this.userAddress,
        durationSeconds: BigInt(durationSeconds),
        nonce: BigInt(nonceRes.nonce),
        deadline: BigInt(deadline),
      },
    });

    const res = await this.req<{ token: string; expiresAt: number }>(
      "POST",
      "/auth/trading-session",
      {
        userAddress: this.userAddress,
        durationSeconds,
        nonce: nonceRes.nonce,
        deadline,
        signature,
      },
    );

    this.session = { token: res.token, expiresAt: res.expiresAt };
    this.logger.info("Trading session minted", {
      expiresInSec: this.session.expiresAt - now,
    });
    return this.session;
  }

  /**
   * Place a leveraged GTC limit buy order. Returns once the order is RESTING
   * on CLOB (or throws). Requires an active trading session.
   *
   * Notional = `marginUsdc × leverage`. The backend computes shares from
   * `notional / limitPrice` and rounds down to the CLOB tick. Loan principal
   * = `notional × (leverage − 1) / leverage` (issued at place time).
   */
  async placeLimitOrder(args: {
    tokenId: string;
    outcome: "YES" | "NO";
    leverage: number;
    marginUsdc: number;
    limitPrice: number;
  }): Promise<AmplifiOrder> {
    await this.ensureTradingSession();
    const res = await this.req<{ order: AmplifiOrder }>(
      "POST",
      "/polymarket/orders",
      {
        userAddress: this.userAddress,
        tokenId: args.tokenId,
        outcome: args.outcome,
        leverage: args.leverage,
        marginUsdc: args.marginUsdc,
        limitPrice: args.limitPrice,
      },
      { withSession: true, timeoutMs: MUTATION_TIMEOUT_MS },
    );
    return res.order;
  }

  async getOrder(orderId: number): Promise<AmplifiOrder> {
    const res = await this.req<{ order: AmplifiOrder }>(
      "GET",
      `/polymarket/orders/${orderId}/status?userAddress=${this.userAddress}`,
    );
    return res.order;
  }

  async listOrders(
    statuses?: AmplifiOrder["status"][],
  ): Promise<AmplifiOrder[]> {
    const qs = statuses?.length ? `?statuses=${statuses.join(",")}` : "";
    const res = await this.req<{ orders: AmplifiOrder[] }>(
      "GET",
      `/polymarket/orders/${this.userAddress}${qs}`,
    );
    return res.orders;
  }

  /**
   * Cancel a resting limit order. Uses session auth (no per-action EIP-712
   * needed). Backend repays any unused loan principal before returning.
   */
  async cancelOrder(orderId: number): Promise<void> {
    await this.ensureTradingSession();
    await this.req(
      "POST",
      `/polymarket/orders/${orderId}/cancel`,
      { userAddress: this.userAddress },
      { withSession: true, timeoutMs: MUTATION_TIMEOUT_MS },
    );
  }

  /**
   * Place / replace the take-profit limit-sell on a filled position.
   * `takeProfitPrice` is a decimal in (0, 1); backend enforces tp > bestBid.
   */
  async setTakeProfit(
    positionId: number,
    takeProfitPrice: number,
  ): Promise<void> {
    await this.ensureTradingSession();
    await this.req(
      "POST",
      `/polymarket/positions/${positionId}/take-profit`,
      {
        userAddress: this.userAddress,
        takeProfitPrice: takeProfitPrice.toString(),
      },
      { withSession: true, timeoutMs: MUTATION_TIMEOUT_MS },
    );
  }

  async deleteTakeProfit(positionId: number): Promise<void> {
    await this.ensureTradingSession();
    await this.req(
      "DELETE",
      `/polymarket/positions/${positionId}/take-profit`,
      { userAddress: this.userAddress },
      { withSession: true, timeoutMs: MUTATION_TIMEOUT_MS },
    );
  }

  /**
   * Register / replace the SERVER-side stop-loss trigger on a filled
   * position. The backend's own price monitor closes the position at market
   * once the bid crosses `stopLossPrice` — it owns the firing, so the bot
   * only registers the trigger (no bot-side poll race against fast wicks).
   * Price is a decimal in (0, 1); backend enforces liqPrice < sl < bestBid.
   */
  async setStopLoss(positionId: number, stopLossPrice: number): Promise<void> {
    await this.ensureTradingSession();
    await this.req(
      "POST",
      `/polymarket/positions/${positionId}/stop-loss`,
      {
        userAddress: this.userAddress,
        stopLossPrice: stopLossPrice.toString(),
      },
      { withSession: true, timeoutMs: MUTATION_TIMEOUT_MS },
    );
  }

  async getPosition(positionId: number): Promise<AmplifiPosition | null> {
    try {
      return await this.req<AmplifiPosition>(
        "GET",
        `/polymarket/positions/${positionId}`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** List markets amplifi has ingested. The harvester pulls strike data
   *  directly from Gamma, which can race ahead of amplifi's auto-ingest
   *  for far-day strikes (low v24h fails the ingest volume floor). When
   *  the bot opens a position on an un-ingested market, OrderService
   *  finds no `pm_markets` row, passes `category=null`, and routes the
   *  loan to the default pool — which is normally underfunded — causing
   *  `InsufficientLiquidity()` reverts. Callers filter ranker candidates
   *  through the union of `tokenId` and `complementTokenId` returned
   *  here so we only trade strikes amplifi can actually back. */
  async listMarkets(): Promise<
    Array<{ tokenId: string; complementTokenId: string | null }>
  > {
    return this.req("GET", "/polymarket/markets");
  }
}
