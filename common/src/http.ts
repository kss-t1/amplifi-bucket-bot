/**
 * fetch() with a hard per-request timeout.
 *
 * A plain `fetch` has NO default timeout — on a stalled connection (e.g. while
 * an upstream is mid-restart and Cloudflare is returning 502s, or the socket
 * hangs without ever responding) the promise never settles. In a bot's poll
 * loop that silently wedges the whole loop: the `await` never returns, no error
 * is thrown for the surrounding try/catch to catch, and the bot stops polling
 * until a manual restart. `AbortSignal.timeout` makes the request reject after
 * `timeoutMs`, so the caller's existing error handling retries on the next tick.
 */
export const FETCH_TIMEOUT_MS = 15_000;

/** The subset of `fetch` the bots actually use (string/URL + optional init).
 *  Looser than `typeof fetch` (no `preconnect`) so `fetchWithTimeout` and test
 *  mocks are both assignable — used for injectable `fetchFn` params. */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Drop-in `fetch` that aborts after `timeoutMs`. Merges an optional
 *  caller-supplied signal with the timeout so either can abort. Assignable to
 *  `FetchLike` (the extra optional `timeoutMs` is ignored by 2-arg callers). */
export function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;
  return fetch(input, { ...init, signal });
}
