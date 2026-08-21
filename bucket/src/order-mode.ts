export type OrderMode = "maker" | "taker";

export function parseOrderMode(raw: string | undefined): OrderMode {
  if (!raw || raw.trim() === "") return "maker";
  const v = raw.trim().toLowerCase();
  if (v === "maker" || v === "taker") return v;
  throw new Error(`ORDER_MODE must be "maker" or "taker", got "${raw}"`);
}
