/**
 * One-time wallet setup for the lag sniper's EOA.
 *
 *   LAG_PRIVATE_KEY=0x… POLYGON_RPC_URL=… bun scripts/lag-setup.ts [--apply]
 *
 * Prints the wallet's POL and pUSD balances and whether the CLOB exchange may
 * spend its pUSD and move its outcome tokens. With --apply it sends the
 * missing approvals; without it nothing is sent. It never moves funds.
 */
import { getContractConfig } from "@polymarket/clob-client-v2";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  maxUint256,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const key = process.env.LAG_PRIVATE_KEY as Hex | undefined;
const rpc = process.env.POLYGON_RPC_URL;
if (!key || !rpc) throw new Error("set LAG_PRIVATE_KEY and POLYGON_RPC_URL");
const apply = process.argv.includes("--apply");

const cfg = getContractConfig(polygon.id);
const account = privateKeyToAccount(key);
const pub = createPublicClient({ chain: polygon, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: polygon, transport: http(rpc) });
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const ctf = parseAbi([
  "function isApprovedForAll(address,address) view returns (bool)",
  "function setApprovalForAll(address,bool)",
]);
const pusd = cfg.collateral as Hex;
const exchange = cfg.exchangeV2 as Hex;
const tokens = cfg.conditionalTokens as Hex;

const [pol, bal, allowance, approved] = await Promise.all([
  pub.getBalance({ address: account.address }),
  pub.readContract({ address: pusd, abi: erc20, functionName: "balanceOf", args: [account.address] }),
  pub.readContract({ address: pusd, abi: erc20, functionName: "allowance", args: [account.address, exchange] }),
  pub.readContract({ address: tokens, abi: ctf, functionName: "isApprovedForAll", args: [account.address, exchange] }),
]);
console.log(`wallet      https://polygonscan.com/address/${account.address}`);
console.log(`POL         ${formatUnits(pol, 18)}`);
console.log(`pUSD        ${formatUnits(bal, 6)}`);
console.log(`pUSD → exchange allowance ${allowance === maxUint256 ? "max" : formatUnits(allowance, 6)}`);
console.log(`outcome tokens → exchange ${approved ? "approved" : "not approved"}`);

const todo: { what: string; send: () => Promise<Hex> }[] = [];
if (allowance < maxUint256 / 2n)
  todo.push({
    what: "approve pUSD for the exchange",
    send: () => wallet.writeContract({ address: pusd, abi: erc20, functionName: "approve", args: [exchange, maxUint256] }),
  });
if (!approved)
  todo.push({
    what: "approve outcome tokens for the exchange",
    send: () => wallet.writeContract({ address: tokens, abi: ctf, functionName: "setApprovalForAll", args: [exchange, true] }),
  });

if (!todo.length) console.log("nothing to do");
for (const t of todo) {
  if (!apply) {
    console.log(`would ${t.what} (rerun with --apply)`);
    continue;
  }
  const hash = await t.send();
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`${t.what}: ${r.status} https://polygonscan.com/tx/${hash}`);
}
