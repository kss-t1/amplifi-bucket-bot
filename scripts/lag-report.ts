/**
 * Summarises the lag sniper's positions: bun scripts/lag-report.ts [state file]
 */
import { readFileSync } from "node:fs";
import { positionPnl, type Position } from "../lag/src/settlement.ts";

const file = process.argv[2] ?? "lag/.state.dry.json";
const { positions } = JSON.parse(readFileSync(file, "utf8")) as { positions: Position[] };
const settled = positions.filter((p) => p.payout !== undefined);
const open = positions.filter((p) => p.payout === undefined);
const pnl = settled.reduce((a, p) => a + positionPnl(p)!, 0);
const cost = settled.reduce((a, p) => a + p.cost, 0);
const shares = settled.reduce((a, p) => a + p.shares, 0);
const wins = settled.filter((p) => p.payout === 1).length;
console.log(`positions   ${positions.length} (${open.length} open, $${open.reduce((a, p) => a + p.cost, 0).toFixed(2)} at stake)`);
console.log(`settled     ${settled.length}, won ${wins}`);
console.log(`P&L         $${pnl.toFixed(2)} on $${cost.toFixed(2)} cost (${shares ? ((pnl / shares) * 100).toFixed(2) : "0"}c per share)`);
const byDay = new Map<string, number>();
for (const p of settled) {
  const d = new Date(p.endMs).toISOString().slice(0, 10);
  byDay.set(d, (byDay.get(d) ?? 0) + positionPnl(p)!);
}
for (const [d, v] of [...byDay].sort()) console.log(`  ${d}  $${v.toFixed(2)}`);
