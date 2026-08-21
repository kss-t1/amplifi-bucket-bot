import type { Address } from "viem";
import { polygon } from "viem/chains";

export function buildAmplifiBaseDomain(chainId: number = polygon.id) {
  return {
    name: "Amplifi",
    version: "1",
    chainId,
  } as const;
}

const AMPLIFI_DOMAIN_BASE = buildAmplifiBaseDomain();

export type AmplifiDomain = typeof AMPLIFI_DOMAIN_BASE & {
  verifyingContract: Address;
};

/**
 * Build the EIP-712 domain separator. Includes verifyingContract to prevent
 * cross-protocol signature reuse (phishing mitigation).
 */
export function buildAmplifiDomain(
  verifyingContract: Address,
  chainId: number = polygon.id,
): AmplifiDomain {
  return {
    ...buildAmplifiBaseDomain(chainId),
    verifyingContract,
  } as const;
}

/** EIP-712 types for signed open-position requests. */
export const OPEN_POSITION_TYPES = {
  OpenPositionIntent: [
    { name: "userAddress", type: "address" },
    { name: "tokenId", type: "bytes32" },
    { name: "outcome", type: "string" },
    { name: "usdcAmount", type: "uint256" },
    { name: "leverage", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** EIP-712 types for signed close-position requests. */
export const CLOSE_POSITION_TYPES = {
  ClosePositionIntent: [
    { name: "userAddress", type: "address" },
    { name: "positionId", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** EIP-712 types for signed merge-positions requests. Burns the matched portion
 *  of a complementary YES+NO holding back into collateral via CTF.mergePositions. */
export const MERGE_POSITIONS_TYPES = {
  MergePositionsIntent: [
    { name: "userAddress", type: "address" },
    { name: "yesPositionId", type: "uint256" },
    { name: "noPositionId", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * EIP-712 types for signed admin force-close requests. Used by operators to
 * close any position during pool migrations without holding the user's key.
 * Authorization comes from the recovered signer being in the
 * `ADMIN_FORCE_CLOSE_ADDRESSES` env-var allowlist.
 */
export const ADMIN_CLOSE_POSITION_TYPES = {
  AdminClosePositionIntent: [
    { name: "adminAddress", type: "address" },
    { name: "positionId", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** EIP-712 types for signed withdrawal requests. */
export const WITHDRAW_TYPES = {
  WithdrawalIntent: [
    { name: "userAddress", type: "address" },
    { name: "destinationAddress", type: "address" },
    { name: "usdcAmount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * EIP-712 types for a cross-chain (CCTP) withdrawal. A SEPARATE struct from
 * WITHDRAW_TYPES so existing Polygon-direct withdrawal signatures keep
 * verifying unchanged. `destinationDomain` is the Circle CCTP domain of the
 * payout chain (29 = Injective); binding it in the signature prevents a
 * request from redirecting the user's funds to another chain.
 */
export const CROSSCHAIN_WITHDRAW_PRIMARY_TYPE =
  "CrossChainWithdrawalIntent" as const;
export const CROSSCHAIN_WITHDRAW_TYPES = {
  CrossChainWithdrawalIntent: [
    { name: "userAddress", type: "address" },
    { name: "destinationAddress", type: "address" },
    { name: "usdcAmount", type: "uint256" },
    { name: "destinationDomain", type: "uint32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** EIP-712 types for signed loan repayment requests. */
export const REPAY_LOAN_TYPES = {
  RepayLoanIntent: [
    { name: "userAddress", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** EIP-712 types for signed cancel-order requests (keyed on pm_orders.id). */
export const CANCEL_ORDER_TYPES = {
  CancelOrderIntent: [
    { name: "userAddress", type: "address" },
    { name: "orderId", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** EIP-712 types for creating a one-click trading session. */
export const TRADING_SESSION_TYPES = {
  TradingSessionIntent: [
    { name: "userAddress", type: "address" },
    { name: "durationSeconds", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * EIP-712 types for the one-time delegate registration in the debug DB API.
 * The user (with their wallet PK) authorizes a delegate address to run
 * read-only SELECT queries on their behalf until `expiry`.
 */
export const DELEGATE_DEBUG_KEY_TYPES = {
  DelegateDebugKey: [
    { name: "user", type: "address" },
    { name: "delegate", type: "address" },
    { name: "expiry", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * EIP-712 types for a per-query signature in the debug DB API. The delegate
 * signs `keccak256(sql)` plus a deadline; replay of a SELECT is harmless,
 * the deadline prevents stale leaked signatures from being usable forever.
 */
export const DEBUG_QUERY_TYPES = {
  DebugQuery: [
    { name: "delegate", type: "address" },
    { name: "sqlHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * EIP-712 types for applying a referral code. Prevents an attacker from
 * squatting a victim's referee slot by self-asserting `x-wallet-address`.
 * The signer is the referee; the recovered address must equal `refereeAddress`.
 */
export const APPLY_REFERRAL_TYPES = {
  ApplyReferralIntent: [
    { name: "refereeAddress", type: "address" },
    { name: "code", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/**
 * EIP-712 types for confirming a Relay-bridge deposit. The signer is the
 * depositor, so the recovered address must equal `userAddress`. `txHash` is
 * bound so a captured signature cannot be replayed against another
 * transaction; the nonce and deadline stop it being replayed against the same
 * one.
 */
export const BRIDGE_DEPOSIT_CONFIRM_TYPES = {
  BridgeDepositConfirmIntent: [
    { name: "userAddress", type: "address" },
    { name: "txHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
