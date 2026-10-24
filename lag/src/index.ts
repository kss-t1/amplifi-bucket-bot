/**
 * Lag sniper entry point: bun lag/src/index.ts
 *
 * DRY_RUN=true (default) paper-trades against the live books and journals
 * every signal. DRY_RUN=false trades from the EOA in LAG_PRIVATE_KEY; run
 * scripts/lag-setup.ts once first to set the exchange approvals.
 */
import { BTC_FAIR_VALUE_PARAMS } from "../../common/src/btc-fair-value-params.ts";
import { createConsoleLogger, installSignalHandlers } from "../../common/src/runtime.ts";
import { BinanceFeed } from "./binance.ts";
import { BookFeed } from "./book-feed.ts";
import { loadLagConfig } from "./config.ts";
import { LiveExecutor, PaperExecutor, type Executor } from "./executor.ts";
import { LagBot } from "./lag-bot.ts";
import { Redeemer } from "./settlement.ts";

const HOUR = 3_600_000;
const logger = createConsoleLogger();

async function main() {
  const cfg = loadLagConfig();
  logger.info("lag sniper starting", {
    mode: cfg.dryRun ? "paper" : "LIVE",
    signal: cfg.signal,
    maxTradeUsd: cfg.maxTradeUsd,
    maxStrikeUsd: cfg.maxStrikeUsd,
    maxOpenUsd: cfg.maxOpenUsd,
  });

  let executor: Executor = new PaperExecutor();
  let redeemer: Redeemer | null = null;
  if (!cfg.dryRun) {
    const live = new LiveExecutor(cfg.privateKey!);
    await live.init();
    executor = live;
    redeemer = new Redeemer(cfg.privateKey!, cfg.polygonRpcUrl!);
  }

  const spot = new BinanceFeed((BTC_FAIR_VALUE_PARAMS.windowHours + 2) * HOUR, logger);
  await spot.start();
  let bot: LagBot | null = null;
  const books = new BookFeed(logger, (tokenId) => bot?.evaluate(tokenId));
  bot = new LagBot(cfg, spot, books, executor, redeemer, logger);
  installSignalHandlers(bot, logger);
  await bot.run();
  logger.info("lag sniper exited cleanly");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
