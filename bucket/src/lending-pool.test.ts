import { describe, expect, it } from "bun:test";
import { expectedRoiOnCollateral } from "./lending-pool.ts";

describe("expectedRoiOnCollateral", () => {
  it("matches the closed-form ROI at zero APR (pure leveraged upside)", () => {
    // L·(1−p)/p with apr=0 → just the leveraged upside.
    const roi = expectedRoiOnCollateral({
      entryPrice: 0.95,
      leverage: 7,
      aprDecimal: 0,
      hoursToResolution: 24,
    });
    expect(roi).toBeCloseTo((7 * 0.05) / 0.95, 6);
  });

  it("subtracts (L−1)·apr·t at non-zero APR", () => {
    // 30% APR, 24h hold, 10x.
    //   interest = 9 × 0.30 × (24/8760) ≈ 0.007397
    //   upside   = 10 × (1 − 0.995) / 0.995 ≈ 0.050251
    //   roi      ≈ 0.042854
    const roi = expectedRoiOnCollateral({
      entryPrice: 0.995,
      leverage: 10,
      aprDecimal: 0.3,
      hoursToResolution: 24,
    });
    expect(roi).toBeCloseTo(0.042854, 5);
  });

  it("returns the unlevered (1−p)/p when leverage=1 (no interest term)", () => {
    const roi = expectedRoiOnCollateral({
      entryPrice: 0.9,
      leverage: 1,
      aprDecimal: 0.3,
      hoursToResolution: 720,
    });
    expect(roi).toBeCloseTo(0.1 / 0.9, 6);
  });

  it("goes negative when interest exceeds leveraged upside (the failure mode the gate exists to catch)", () => {
    const roi = expectedRoiOnCollateral({
      entryPrice: 0.999,
      leverage: 10,
      aprDecimal: 0.5,
      hoursToResolution: 24 * 30,
    });
    expect(roi).toBeLessThan(0);
  });
});
