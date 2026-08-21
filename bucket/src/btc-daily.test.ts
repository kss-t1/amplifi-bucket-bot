import { afterEach, describe, expect, it, mock } from "bun:test";
import { fetchUpcomingBtcDailyEvents } from "./btc-daily.ts";
import type { GammaEvent } from "../../common/src/gamma.ts";

function makeEvent(slug: string, endDate: string, closed = false): GammaEvent {
  return {
    id: slug,
    slug,
    endDate,
    closed,
    markets: [
      {
        id: `${slug}-m1`,
        conditionId: `0x${slug}`,
        slug: `bitcoin-above-78k-on-${slug}`,
        groupItemTitle: "78,000",
        outcomePrices: JSON.stringify(["0.95", "0.05"]),
        clobTokenIds: JSON.stringify(["1", "2"]),
        outcomes: JSON.stringify(["Yes", "No"]),
        endDate,
        closed: false,
      },
    ],
  };
}

function mockGammaResponse(events: GammaEvent[]): void {
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify(events), {
        headers: { "content-type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

describe("fetchUpcomingBtcDailyEvents", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("bins events by UTC calendar day, day 0 = next 16:00 UTC resolution", async () => {
    mockGammaResponse([
      makeEvent("bitcoin-above-on-may-22-2026", "2026-05-22T16:00:00Z"),
      makeEvent("bitcoin-above-on-may-20", "2026-05-20T16:00:00Z"),
      makeEvent("bitcoin-above-on-may-19", "2026-05-19T16:00:00Z"),
      makeEvent("bitcoin-above-on-may-21", "2026-05-21T16:00:00Z"),
      makeEvent("bitcoin-above-on-may-23-2026", "2026-05-23T16:00:00Z"),
    ]);

    // After may-19's 16:00 cutoff → day 0 = may-20.
    const out = await fetchUpcomingBtcDailyEvents(
      new Date("2026-05-19T20:00:00Z"),
      4,
    );
    expect(out.map((e) => e?.slug ?? null)).toEqual([
      "bitcoin-above-on-may-20",
      "bitcoin-above-on-may-21",
      "bitcoin-above-on-may-22-2026",
      "bitcoin-above-on-may-23-2026",
    ]);
  });

  it("returns null at the day-index for missing calendar days (no shift)", async () => {
    // Polymarket skips may-22. Old sort-and-slice would pull may-23 into
    // index 2 and apply day-2's (48-72h) weight to it, although it's
    // actually 72-96h out. We want null at index 2 instead.
    mockGammaResponse([
      makeEvent("bitcoin-above-on-may-20", "2026-05-20T16:00:00Z"),
      makeEvent("bitcoin-above-on-may-21", "2026-05-21T16:00:00Z"),
      makeEvent("bitcoin-above-on-may-23-2026", "2026-05-23T16:00:00Z"),
      makeEvent("bitcoin-above-on-may-24-2026", "2026-05-24T16:00:00Z"),
    ]);
    const out = await fetchUpcomingBtcDailyEvents(
      new Date("2026-05-19T20:00:00Z"),
      6,
    );
    expect(out.map((e) => e?.slug ?? null)).toEqual([
      "bitcoin-above-on-may-20",
      "bitcoin-above-on-may-21",
      null, // may-22 missing — keep day-2 slot empty, do NOT shift may-23 in
      "bitcoin-above-on-may-23-2026",
      "bitcoin-above-on-may-24-2026",
      null, // no may-25 event yet
    ]);
  });

  it("when called pre-16:00 UTC, day 0 is TODAY's resolution", async () => {
    mockGammaResponse([
      makeEvent("bitcoin-above-on-may-19", "2026-05-19T16:00:00Z"),
      makeEvent("bitcoin-above-on-may-20", "2026-05-20T16:00:00Z"),
    ]);
    // 10:00 UTC may-19 — today's 16:00 hasn't fired yet.
    const out = await fetchUpcomingBtcDailyEvents(
      new Date("2026-05-19T10:00:00Z"),
      2,
    );
    expect(out.map((e) => e?.slug ?? null)).toEqual([
      "bitcoin-above-on-may-19",
      "bitcoin-above-on-may-20",
    ]);
  });

  it("uses the configured series id in the query string", async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (input: unknown) => {
      calls.push(String(input));
      return new Response(JSON.stringify([]));
    }) as unknown as typeof fetch;

    await fetchUpcomingBtcDailyEvents(new Date(), 6, { seriesId: 99 });
    expect(calls.at(0)).toContain("series_id=99");
    expect(calls.at(0)).toContain("closed=false");
  });

  it("propagates non-2xx Gamma responses as errors", async () => {
    globalThis.fetch = mock(
      async () => new Response("", { status: 502 }),
    ) as unknown as typeof fetch;
    expect(fetchUpcomingBtcDailyEvents(new Date(), 6)).rejects.toThrow(
      /gamma series/,
    );
  });

  it("skips events with invalid endDate", async () => {
    mockGammaResponse([
      makeEvent("bitcoin-above-on-may-20", "2026-05-20T16:00:00Z"),
      makeEvent("bad", "not-a-date"),
    ]);
    const out = await fetchUpcomingBtcDailyEvents(
      new Date("2026-05-19T20:00:00Z"),
      2,
    );
    expect(out.map((e) => e?.slug ?? null)).toEqual([
      "bitcoin-above-on-may-20",
      null,
    ]);
  });
});
