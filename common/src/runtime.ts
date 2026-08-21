/**
 * Tiny runtime helpers shared by bots: a console-backed Logger factory, a
 * SIGINT/SIGTERM hook that calls `bot.stop()`, and an abort-aware sleep.
 *
 * Kept deliberately small — anything that needs structured logging,
 * metrics, or graceful-shutdown coordination should live in the bot's
 * own module and import these primitives.
 */
import type { Logger } from "./amplifi-client.ts";

/** Console-backed Logger that prefixes each level — the same `[INFO]` /
 *  `[WARN]` / `[ERROR]` shape every bot has been duplicating in index.ts. */
export function createConsoleLogger(): Logger {
  return {
    info: (msg, data) =>
      console.log(`[INFO] ${msg}`, data !== undefined ? data : ""),
    warn: (msg, data) =>
      console.warn(`[WARN] ${msg}`, data !== undefined ? data : ""),
    error: (msg, data) =>
      console.error(`[ERROR] ${msg}`, data !== undefined ? data : ""),
  };
}

export interface Stoppable {
  stop(): void;
}

/** Register SIGINT + SIGTERM handlers that call `bot.stop()` and log the
 *  signal. Idempotent — safe to call once per process. */
export function installSignalHandlers(bot: Stoppable, logger: Logger): void {
  process.on("SIGINT", () => {
    logger.info("SIGINT received, stopping");
    bot.stop();
  });
  process.on("SIGTERM", () => {
    logger.info("SIGTERM received, stopping");
    bot.stop();
  });
}

/** Sleep that resolves early if `signal` aborts. Removes the abort listener
 *  on every exit path — without that, an indefinite poll loop accumulates
 *  thousands of dead listeners and trips MaxListenersExceededWarning. */
export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
