/**
 * Bucket-bot entry point.
 *
 * Usage: bun run bots/bucket/src/index.ts
 *
 * Reads config from env (see bots/bucket/.env.example). Set DRY_RUN=true
 * (default) to log decisions without sending intents; DRY_RUN=false trades
 * for real. Per the design, run three instances with separate EOAs and
 * .env files — typically one per bucket flavor, with ABOVE_BELOW_RESTRICTED
 * toggled on a single profile.
 */
import { loadConfig } from "./config.ts";
import { AmplifiClient } from "../../common/src/amplifi-client.ts";
import { MarketResolver } from "../../common/src/market-resolver.ts";
import {
  createConsoleLogger,
  installSignalHandlers,
} from "../../common/src/runtime.ts";
import { BucketBot } from "./bucket-bot.ts";

const logger = createConsoleLogger();

async function main() {
  const cfg = loadConfig();
  const client = new AmplifiClient(
    cfg.apiBase,
    cfg.botPrivateKey,
    cfg.botAddress,
    logger,
    process.env.POLYGON_RPC_URL,
  );

  const health = await client.health();
  logger.info("amplifi health", health);

  const resolver = new MarketResolver(cfg.apiBase);
  const bot = new BucketBot(cfg, client, resolver, logger);

  installSignalHandlers(bot, logger);

  await bot.run();
  logger.info("bot exited cleanly");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
