/**
 * Pipeline reconciliation helper. `/polymarket/pipeline/<address>` returns
 * BOTH open and closed entries concatenated (`PolymarketController.getPipeline`
 * builds `[...openEntries, ...closedEntries]`), so any bot that needs to
 * know "which of my positions still hold margin" must filter on
 * `position.status` — not just rely on presence in the list.
 *
 * Mirrors the live-status set in
 * `PositionRepository.findOpenByUserAddressAndVenue` (PENDING / OPENING /
 * OPEN). Anything else (CLOSED / LIQUIDATED / FAILED) means the slot's
 * capital is back in the Safe and the bot is free to redeploy.
 */

export const LIVE_POSITION_STATUSES: ReadonlySet<string> = new Set([
  "PENDING",
  "OPENING",
  "OPEN",
]);

interface PipelineEntry {
  position: {
    id: number;
    status: string;
  };
}

/**
 * Fetch the address's pipeline and return the set of positionIds whose
 * status is currently in {PENDING, OPENING, OPEN}. Lowercases the address
 * before the request — the route regex requires lowercase hex (matches
 * `Vm018`'s convention for user-keyed endpoints).
 */
export async function fetchLivePositionIds(
  apiBase: string,
  address: string,
): Promise<Set<number>> {
  const res = await fetch(
    `${apiBase}/polymarket/pipeline/${address.toLowerCase()}`,
  );
  if (!res.ok) throw new Error(`pipeline fetch ${res.status}`);
  const data = (await res.json()) as PipelineEntry[];
  if (!Array.isArray(data)) return new Set();
  return new Set<number>(
    data
      .filter((e) => LIVE_POSITION_STATUSES.has(e.position.status))
      .map((e) => e.position.id)
      .filter((id) => Number.isFinite(id)),
  );
}
