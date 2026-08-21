import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { loadConfig } from "./config.ts";

const ENV_KEYS = [
  "BOT_PRIVATE_KEY",
  "BOT_ADDRESS",
  "AMPLIFI_API_BASE",
  "BUCKETS",
  "LEVERAGE_90_95",
  "LEVERAGE_95_97",
  "LEVERAGE_97_PLUS",
  "LEVERAGE_97_99",
  "LEVERAGE_99_PLUS",
  "TOTAL_CAPITAL_USD",
  "DAYS",
  "DAY_WEIGHTS",
  "TP_ROE_PCT",
  "TP_ACTIVE_EXIT",
  "MAX_HOURS_TO_RESOLUTION",
  "MIN_HOURS_TO_RESOLUTION",
  "MAX_HOURS_90_95",
  "MAX_HOURS_95_97",
  "MAX_HOURS_97_99",
  "MAX_HOURS_99_PLUS",
  "MIN_HOURS_90_95",
  "MIN_HOURS_95_97",
  "MIN_HOURS_97_99",
  "MIN_HOURS_99_PLUS",
  "DRY_RUN",
  "VOL_GATE_ENABLED",
  "VOL_GATE_RULES",
  "BTC_VOL_POLL_MS",
  "REENTRY_COOLDOWN_MS",
];

function setMinimalEnv() {
  process.env.BOT_PRIVATE_KEY = "0x" + "11".repeat(32);
  process.env.BOT_ADDRESS = "0x000000000000000000000000000000000000dead";
  process.env.AMPLIFI_API_BASE = "https://example.test";
  process.env.DRY_RUN = "true";
}

describe("loadConfig — bucket / leverage parsing", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    setMinimalEnv();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults BUCKETS to all four (0.90-0.95, 0.95-0.97, 0.97-0.99, 0.99+)", () => {
    const cfg = loadConfig();
    expect([...cfg.allowedBuckets].sort() as string[]).toEqual(
      ["0.90-0.95", "0.95-0.97", "0.97-0.99", "0.99+"].sort(),
    );
  });

  it("legacy BUCKETS=0.97+ alias expands to both upper buckets", () => {
    process.env.BUCKETS = "0.97+";
    const cfg = loadConfig();
    expect([...cfg.allowedBuckets].sort() as string[]).toEqual(
      ["0.97-0.99", "0.99+"].sort(),
    );
  });

  it("explicit BUCKETS=0.99+ selects only the new top bucket", () => {
    process.env.BUCKETS = "0.99+";
    const cfg = loadConfig();
    expect([...cfg.allowedBuckets]).toEqual(["0.99+"]);
  });

  it("rejects unknown bucket tokens", () => {
    process.env.BUCKETS = "0.50+";
    expect(() => loadConfig()).toThrow(/unknown bucket/);
  });

  it("vol gate defaults: disabled, dual 15m/4h rules, 20s poll, no cooldown", () => {
    const cfg = loadConfig();
    expect(cfg.volGateEnabled).toBe(false);
    expect(cfg.volRules.map((r) => `${r.label}:${r.thresholdPct}`)).toEqual([
      "15m:0.8",
      "4h:2",
    ]);
    expect(cfg.btcVolPollMs).toBe(20_000);
    expect(cfg.reentryCooldownMs).toBeUndefined();
  });

  it("parses a custom multi-window vol gate + enable flag + cooldown", () => {
    process.env.VOL_GATE_ENABLED = "true";
    process.env.VOL_GATE_RULES = "5m:0.5,1h:1.5,1d:6";
    process.env.REENTRY_COOLDOWN_MS = "1800000";
    const cfg = loadConfig();
    expect(cfg.volGateEnabled).toBe(true);
    expect(cfg.volRules).toHaveLength(3);
    expect(cfg.volRules[2]!.windowMs).toBe(24 * 60 * 60 * 1000);
    expect(cfg.reentryCooldownMs).toBe(1_800_000);
  });

  it("rejects a malformed vol gate rule", () => {
    process.env.VOL_GATE_RULES = "15m=0.8";
    expect(() => loadConfig()).toThrow(/VOL_GATE_RULES/);
  });

  it("defaults leverage to the cliff-aware per-bucket optima (4 / 5 / 8 / 10)", () => {
    const cfg = loadConfig();
    expect(cfg.leveragePerBucket).toEqual({
      "0.90-0.95": 4,
      "0.95-0.97": 5,
      "0.97-0.99": 8,
      "0.99+": 10,
    });
  });

  it("TP_ACTIVE_EXIT defaults to false and parses true", () => {
    expect(loadConfig().tpActiveExit).toBe(false);
    process.env.TP_ACTIVE_EXIT = "true";
    expect(loadConfig().tpActiveExit).toBe(true);
    process.env.TP_ACTIVE_EXIT = "TRUE";
    expect(loadConfig().tpActiveExit).toBe(true);
    process.env.TP_ACTIVE_EXIT = "false";
    expect(loadConfig().tpActiveExit).toBe(false);
  });

  it("LEVERAGE_97_PLUS (legacy) cascades to both upper buckets when 97_99 / 99_PLUS unset", () => {
    process.env.LEVERAGE_97_PLUS = "9";
    const cfg = loadConfig();
    expect(cfg.leveragePerBucket["0.97-0.99"]).toBe(9);
    expect(cfg.leveragePerBucket["0.99+"]).toBe(9);
  });

  it("explicit LEVERAGE_97_99 and LEVERAGE_99_PLUS override legacy fallback", () => {
    process.env.LEVERAGE_97_PLUS = "10"; // legacy ignored when both set
    process.env.LEVERAGE_97_99 = "8";
    process.env.LEVERAGE_99_PLUS = "10";
    const cfg = loadConfig();
    expect(cfg.leveragePerBucket["0.97-0.99"]).toBe(8);
    expect(cfg.leveragePerBucket["0.99+"]).toBe(10);
  });

  it("mixed: explicit LEVERAGE_99_PLUS, legacy fills 97-0.99", () => {
    process.env.LEVERAGE_97_PLUS = "8";
    process.env.LEVERAGE_99_PLUS = "10";
    // LEVERAGE_97_99 unset → falls back to legacy 8
    const cfg = loadConfig();
    expect(cfg.leveragePerBucket["0.97-0.99"]).toBe(8);
    expect(cfg.leveragePerBucket["0.99+"]).toBe(10);
  });

  it("rejects non-integer / out-of-range leverage", () => {
    process.env.LEVERAGE_99_PLUS = "0";
    expect(() => loadConfig()).toThrow(/LEVERAGE/);
  });

  it("MAX_HOURS_TO_RESOLUTION unset → maxHoursToResolution is undefined", () => {
    const cfg = loadConfig();
    expect(cfg.maxHoursToResolution).toBeUndefined();
  });

  it("MAX_HOURS_TO_RESOLUTION parsed when set", () => {
    process.env.MAX_HOURS_TO_RESOLUTION = "36";
    const cfg = loadConfig();
    expect(cfg.maxHoursToResolution).toBe(36);
  });

  it("MAX_HOURS_TO_RESOLUTION accepts fractional hours", () => {
    process.env.MAX_HOURS_TO_RESOLUTION = "12.5";
    const cfg = loadConfig();
    expect(cfg.maxHoursToResolution).toBe(12.5);
  });

  it("MAX_HOURS_TO_RESOLUTION rejects non-positive values", () => {
    process.env.MAX_HOURS_TO_RESOLUTION = "0";
    expect(() => loadConfig()).toThrow(/MAX_HOURS_TO_RESOLUTION/);
    process.env.MAX_HOURS_TO_RESOLUTION = "-1";
    expect(() => loadConfig()).toThrow(/MAX_HOURS_TO_RESOLUTION/);
  });

  it("MAX_HOURS_TO_RESOLUTION rejects non-numeric values", () => {
    process.env.MAX_HOURS_TO_RESOLUTION = "abc";
    expect(() => loadConfig()).toThrow(/MAX_HOURS_TO_RESOLUTION/);
  });

  it("global MAX_HOURS applies to every bucket; coarse cutoff = that value", () => {
    process.env.MAX_HOURS_TO_RESOLUTION = "24";
    const cfg = loadConfig();
    expect(cfg.maxHoursPerBucket).toEqual({
      "0.90-0.95": 24,
      "0.95-0.97": 24,
      "0.97-0.99": 24,
      "0.99+": 24,
    });
    expect(cfg.maxHoursToResolution).toBe(24);
  });

  it("per-bucket MAX_HOURS overrides global; others fall back to global", () => {
    process.env.MAX_HOURS_TO_RESOLUTION = "24";
    process.env.MAX_HOURS_97_99 = "18";
    const cfg = loadConfig();
    expect(cfg.maxHoursPerBucket["0.97-0.99"]).toBe(18);
    expect(cfg.maxHoursPerBucket["0.90-0.95"]).toBe(24);
    expect(cfg.maxHoursPerBucket["0.99+"]).toBe(24);
    // coarse event cutoff = loosest (max) per-bucket cap.
    expect(cfg.maxHoursToResolution).toBe(24);
  });

  it("per-bucket MAX_HOURS with no global → only that bucket capped, coarse undefined (uncapped buckets must keep trading far-out events)", () => {
    process.env.MAX_HOURS_97_99 = "18";
    const cfg = loadConfig();
    expect(cfg.maxHoursPerBucket["0.97-0.99"]).toBe(18);
    expect(cfg.maxHoursPerBucket["0.99+"]).toBeUndefined();
    // Some buckets are uncapped → the coarse event-level cutoff must be
    // undefined so the pre-filter doesn't drop events those buckets could
    // still trade; the allocator applies the 18h cap to 0.97-0.99 alone.
    expect(cfg.maxHoursToResolution).toBeUndefined();
  });

  it("MIN_HOURS global + per-bucket override parse", () => {
    process.env.MIN_HOURS_TO_RESOLUTION = "2";
    process.env.MIN_HOURS_99_PLUS = "4";
    const cfg = loadConfig();
    expect(cfg.minHoursPerBucket["0.90-0.95"]).toBe(2);
    expect(cfg.minHoursPerBucket["0.99+"]).toBe(4);
  });

  it("rejects MIN >= MAX for a bucket", () => {
    process.env.MAX_HOURS_97_99 = "12";
    process.env.MIN_HOURS_97_99 = "12";
    expect(() => loadConfig()).toThrow(/MIN hours.*MAX hours.*0\.97-0\.99/);
  });

  it("per-bucket hours unset → undefined per bucket, coarse undefined", () => {
    const cfg = loadConfig();
    expect(cfg.maxHoursPerBucket["0.97-0.99"]).toBeUndefined();
    expect(cfg.minHoursPerBucket["0.97-0.99"]).toBeUndefined();
    expect(cfg.maxHoursToResolution).toBeUndefined();
  });
});
