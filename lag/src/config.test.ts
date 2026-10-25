import { describe, expect, test } from "bun:test";
import { loadLagConfig } from "./config.ts";

describe("loadLagConfig", () => {
  test("defaults to paper trading with the backtested signal", () => {
    const c = loadLagConfig({});
    expect(c.dryRun).toBe(true);
    expect(c.privateKey).toBeNull();
    expect(c.signal).toEqual({
      margin: 0.01,
      halfLifeSec: 60,
      cooldownSec: 60,
      minPrice: 0.9,
      maxPrice: 0.99,
      takerFeeRate: 0.07,
    });
    expect(c.stateFile).toBe("lag/.state.dry.json");
  });

  test("live mode needs a well-formed key and an RPC URL", () => {
    expect(() => loadLagConfig({ DRY_RUN: "false" })).toThrow(/LAG_PRIVATE_KEY/);
    expect(() =>
      loadLagConfig({ DRY_RUN: "false", LAG_PRIVATE_KEY: `0x${"1".repeat(64)}` }),
    ).toThrow(/POLYGON_RPC_URL/);
    const c = loadLagConfig({ DRY_RUN: "false", LAG_PRIVATE_KEY: `0x${"1".repeat(64)}`, POLYGON_RPC_URL: "http://x" });
    expect(c.dryRun).toBe(false);
    expect(c.stateFile).toBe("lag/.state.live.json");
  });

  test("rejects a non-numeric knob", () => {
    expect(() => loadLagConfig({ LAG_MARGIN: "1c" })).toThrow(/LAG_MARGIN/);
  });
});
