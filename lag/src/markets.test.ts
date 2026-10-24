import { describe, expect, test } from "bun:test";
import type { GammaEvent } from "../../common/src/gamma.ts";
import { noonEasternMs, strikesFromEvents } from "./markets.ts";

describe("noonEasternMs", () => {
  test("is 16:00 UTC under daylight saving and 17:00 UTC after it ends", () => {
    expect(new Date(noonEasternMs(new Date("2026-10-31T16:00:00Z"))).toISOString()).toBe(
      "2026-10-31T16:00:00.000Z",
    );
    // US daylight saving ends on Sunday 2026-11-01.
    expect(new Date(noonEasternMs(new Date("2026-11-01T17:00:00Z"))).toISOString()).toBe(
      "2026-11-01T17:00:00.000Z",
    );
    expect(new Date(noonEasternMs(new Date("2026-01-15T00:00:00Z"))).toISOString()).toBe(
      "2026-01-15T17:00:00.000Z",
    );
  });
});

const market = (over: Record<string, unknown>) => ({
  id: "1",
  slug: "bitcoin-above-72k-on-october-24-2026",
  conditionId: "0xabc",
  groupItemTitle: "72,000",
  outcomePrices: '["0.9", "0.1"]',
  clobTokenIds: '["111", "222"]',
  outcomes: '["Yes", "No"]',
  endDate: "2026-10-24T16:00:00Z",
  closed: false,
  acceptingOrders: true,
  orderPriceMinTickSize: 0.001,
  orderMinSize: 5,
  negRisk: false,
  ...over,
});

const event = (markets: ReturnType<typeof market>[]): GammaEvent => ({
  id: "e",
  slug: "bitcoin-above-on-october-24-2026",
  endDate: "2026-10-24T16:00:00Z",
  closed: false,
  markets,
});

describe("strikesFromEvents", () => {
  test("parses a strike with its tokens, tick, minimum and resolution time", () => {
    const [s] = strikesFromEvents([event([market({})])]);
    expect(s).toEqual({
      slug: "bitcoin-above-72k-on-october-24-2026",
      conditionId: "0xabc",
      strikeUsd: 72000,
      yesTokenId: "111",
      noTokenId: "222",
      endMs: Date.parse("2026-10-24T16:00:00Z"),
      tickSize: 0.001,
      minShares: 5,
      negRisk: false,
    });
  });

  test("drops closed, non-accepting and malformed markets", () => {
    const out = strikesFromEvents([
      event([
        market({ closed: true }),
        market({ acceptingOrders: false }),
        market({ groupItemTitle: "abc" }),
        market({ clobTokenIds: '["only-one"]' }),
      ]),
    ]);
    expect(out).toEqual([]);
  });
});
