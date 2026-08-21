import { describe, expect, it } from "bun:test";
import {
  emptyStabilityState,
  isStable,
  observe,
  prune,
  stabilityKey,
} from "./stability.ts";

const GAP = 5 * 60_000; // 5-minute gap budget used across the tests

describe("stability buffer", () => {
  it("anchors sinceMs on first observation and keeps it on stable repeats", () => {
    const s = emptyStabilityState();
    observe(s, "btc-78k", "YES", "0.97-0.99", 1_000, GAP);
    observe(s, "btc-78k", "YES", "0.97-0.99", 60_000, GAP);
    observe(s, "btc-78k", "YES", "0.97-0.99", 120_000, GAP);
    const entry = s.byKey[stabilityKey("btc-78k", "YES")]!;
    expect(entry.bucket).toBe("0.97-0.99");
    expect(entry.sinceMs).toBe(1_000);
    expect(entry.lastSeenMs).toBe(120_000);
  });

  it("resets sinceMs when the observed bucket changes", () => {
    const s = emptyStabilityState();
    observe(s, "btc-78k", "YES", "0.97-0.99", 1_000, GAP);
    observe(s, "btc-78k", "YES", "0.95-0.97", 60_000, GAP);
    const entry = s.byKey[stabilityKey("btc-78k", "YES")]!;
    expect(entry.bucket).toBe("0.95-0.97");
    expect(entry.sinceMs).toBe(60_000);
  });

  it("resets sinceMs when the gap since the last observation exceeds maxGapMs", () => {
    // Bot ran, observed, paused (no observations) for longer than the gap
    // budget, then resumed and observed the SAME bucket. The persisted
    // streak must NOT survive — we have no evidence the bucket held
    // during the pause, so the new observation starts a fresh window.
    const s = emptyStabilityState();
    observe(s, "btc-78k", "YES", "0.97-0.99", 1_000, GAP);
    observe(s, "btc-78k", "YES", "0.97-0.99", 1_000 + GAP + 60_000, GAP);
    const entry = s.byKey[stabilityKey("btc-78k", "YES")]!;
    expect(entry.bucket).toBe("0.97-0.99");
    expect(entry.sinceMs).toBe(1_000 + GAP + 60_000);
  });

  it("isStable returns false until the window has elapsed in the same bucket", () => {
    const s = emptyStabilityState();
    const t0 = 1_000;
    const POLL = 60_000; // bot polls every 60s — well inside GAP
    // Tick observations every minute through the 15-min window.
    for (let i = 0; i * POLL <= 14 * 60_000; i++) {
      observe(s, "btc-78k", "YES", "0.97-0.99", t0 + i * POLL, GAP);
    }
    expect(
      isStable(
        s,
        "btc-78k",
        "YES",
        "0.97-0.99",
        15 * 60_000,
        GAP,
        t0 + 14 * 60_000,
      ),
    ).toBe(false);
    // One more poll at 16 min → streak now 15+ min.
    observe(s, "btc-78k", "YES", "0.97-0.99", t0 + 16 * 60_000, GAP);
    expect(
      isStable(
        s,
        "btc-78k",
        "YES",
        "0.97-0.99",
        15 * 60_000,
        GAP,
        t0 + 16 * 60_000,
      ),
    ).toBe(true);
  });

  it("isStable rejects mismatched bucket even after the window", () => {
    const s = emptyStabilityState();
    observe(s, "btc-78k", "YES", "0.97-0.99", 0, GAP);
    observe(s, "btc-78k", "YES", "0.97-0.99", 20 * 60_000, GAP);
    expect(
      isStable(s, "btc-78k", "YES", "0.99+", 15 * 60_000, GAP, 20 * 60_000),
    ).toBe(false);
  });

  it("isStable rejects when the last observation is older than maxGapMs (defense-in-depth path)", () => {
    // This guards callers that read state without re-observing in the same
    // tick. The matching gap-reset in `observe` covers the bot's hot path.
    const s = emptyStabilityState();
    observe(s, "btc-78k", "YES", "0.97-0.99", 0, GAP);
    observe(s, "btc-78k", "YES", "0.97-0.99", 20 * 60_000, GAP);
    const checkAt = 20 * 60_000 + 30 * 60_000;
    expect(
      isStable(s, "btc-78k", "YES", "0.97-0.99", 15 * 60_000, GAP, checkAt),
    ).toBe(false);
  });

  it("isStable returns false for an unknown (slug, outcome)", () => {
    const s = emptyStabilityState();
    expect(isStable(s, "missing", "YES", "0.97-0.99", 1, 1, 1_000_000)).toBe(
      false,
    );
  });

  it("prune drops entries older than stalenessMs", () => {
    const s = emptyStabilityState();
    observe(s, "fresh", "YES", "0.97-0.99", 1_000_000, GAP);
    observe(s, "stale", "NO", "0.95-0.97", 0, GAP);
    prune(s, 1_000_000, 60_000);
    expect(s.byKey[stabilityKey("fresh", "YES")]).toBeDefined();
    expect(s.byKey[stabilityKey("stale", "NO")]).toBeUndefined();
  });
});
