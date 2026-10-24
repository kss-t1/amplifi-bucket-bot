/**
 * Fit the BTC daily fair-value model and test it against Polymarket.
 *
 *   bun scripts/fair-value-calibrate.ts --from 2026-04-13 --to 2026-10-23 [--split 2026-07-18] [--write-params]
 *
 * Everything is fitted on data before --split: the hour-of-day profile on
 * Binance 1-minute closes, then the volatility window, scale and tail mix by
 * log loss on the strikes that resolved before it. Strikes resolving after
 * --split are scored at fixed horizons before the close, for the model and for
 * Polymarket's own price, against the resolved outcome. Downloads are cached
 * under .cache/. --write-params refits on the whole range and saves the
 * parameters the bot loads (common/src/btc-fair-value-params.json).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULT_BTC_DAILY_SERIES_ID } from "../bucket/src/btc-daily.ts";
import { fairValue, profileFromCloses, type TailMix, type VolProfile } from "../common/src/fair-value.ts";
import { parseStringArray, type GammaEvent } from "../common/src/gamma.ts";
import { hourlyVol } from "../common/src/headroom-gate.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CACHE = ".cache";
const PARAMS_PATH = "common/src/btc-fair-value-params.json";

const { values: args } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string" },
    split: { type: "string" },
    horizons: { type: "string", default: "24,12,6,3,1" },
    "write-params": { type: "boolean", default: false },
    concurrency: { type: "string", default: "6" },
  },
});
if (!args.from || !args.to) throw new Error("--from and --to (YYYY-MM-DD) are required");
const fromMs = Date.parse(`${args.from}T00:00:00Z`);
const toMs = Date.parse(`${args.to}T23:59:59Z`);
const splitMs = args.split ? Date.parse(`${args.split}T00:00:00Z`) : fromMs + (toMs - fromMs) / 2;
const horizons = args.horizons!.split(",").map(Number);
mkdirSync(CACHE, { recursive: true });

async function getJson(url: string, tries = 5): Promise<unknown> {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`${res.status}`);
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json();
    } catch (err) {
      if (i + 1 >= tries) throw err;
      await Bun.sleep(1000 * 2 ** i);
    }
  }
}

async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await f(items[i]!);
      }
    }),
  );
  return out;
}

type Close = { ts: number; price: number };

/** Binance 1-minute closes stamped at candle close, cached per UTC day. */
async function binanceCloses(startMs: number, endMs: number): Promise<Close[]> {
  const days: number[] = [];
  for (let d = Math.floor(startMs / DAY) * DAY; d < endMs; d += DAY) days.push(d);
  const perDay = await pool(days, 4, async (d) => {
    const file = `${CACHE}/binance-1m-${new Date(d).toISOString().slice(0, 10)}.json`;
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Close[];
    const rows: Close[] = [];
    for (let t = d; t < d + DAY; t += 1000 * MIN) {
      const end = Math.min(t + 1000 * MIN, d + DAY) - 1;
      const k = (await getJson(
        `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${t}&endTime=${end}&limit=1000`,
      )) as unknown[][];
      for (const r of k) rows.push({ ts: Number(r[6]) + 1, price: Number(r[4]) });
    }
    if (d + DAY <= Date.now()) writeFileSync(file, JSON.stringify(rows));
    return rows;
  });
  return perDay.flat().filter((c) => c.ts >= startMs && c.ts <= endMs).sort((a, b) => a.ts - b.ts);
}

interface Strike { strike: number; yesToken: string; resYes: number; endMs: number; day: string }

async function strikes(): Promise<Strike[]> {
  const file = `${CACHE}/strikes-${args.from}-${args.to}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const out: Strike[] = [];
  for (let offset = 0; ; offset += 100) {
    const evs = (await getJson(
      `https://gamma-api.polymarket.com/events?series_id=${DEFAULT_BTC_DAILY_SERIES_ID}&closed=true&limit=100&offset=${offset}` +
        `&end_date_min=${new Date(fromMs).toISOString()}&end_date_max=${new Date(toMs).toISOString()}`,
    )) as GammaEvent[];
    for (const ev of evs) {
      for (const m of ev.markets ?? []) {
        const strike = Number((m.groupItemTitle ?? "").replace(/,/g, ""));
        const tok = parseStringArray(m.clobTokenIds);
        const px = parseStringArray(m.outcomePrices)?.map(Number);
        if (!(strike > 0) || !tok || tok.length !== 2 || !px) continue;
        const resYes = px[0]! > 0.5 ? 1 : px[1]! > 0.5 ? 0 : NaN;
        if (Number.isNaN(resYes)) continue;
        const endMs = Date.parse(m.endDate ?? ev.endDate);
        out.push({ strike, yesToken: tok[0]!, resYes, endMs, day: new Date(endMs).toISOString().slice(0, 10) });
      }
    }
    if (evs.length < 100) break;
  }
  writeFileSync(file, JSON.stringify(out));
  return out;
}

/** Polymarket price history for one token over the 25h before its close. */
async function marketHistory(s: Strike): Promise<{ t: number; p: number }[]> {
  const file = `${CACHE}/pm-${s.yesToken.slice(-16)}-${s.day}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const e = Math.floor(s.endMs / 1000);
  const j = (await getJson(
    `https://clob.polymarket.com/prices-history?market=${s.yesToken}&startTs=${e - 25 * 3600}&endTs=${e}&fidelity=1`,
  )) as { history?: { t: number; p: number }[] };
  const h = (j.history ?? []).map((x) => ({ t: x.t * 1000, p: x.p }));
  writeFileSync(file, JSON.stringify(h));
  return h;
}

function indexAtOrBefore(ts: number[], at: number): number {
  let lo = 0, hi = ts.length - 1, r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (ts[m]! <= at) { r = m; lo = m + 1; } else hi = m - 1;
  }
  return r;
}

interface Obs { h: number; oos: boolean; y: number; market: number; spot: number; strike: number; ts: number; endMs: number }
interface Params { windowH: number; volScale: number; tails: TailMix }

console.error(`range ${args.from}..${args.to}, fitted before ${new Date(splitMs).toISOString().slice(0, 10)}`);
const closes = await binanceCloses(fromMs - 8 * DAY, toMs);
const closeTs = closes.map((c) => c.ts);
const all = await strikes();
const histories = await pool(all, Number(args.concurrency), marketHistory);
console.error(`binance 1m closes: ${closes.length}; strikes: ${all.length} across ${new Set(all.map((s) => s.day)).size} days`);

const obs: Obs[] = [];
all.forEach((s, k) => {
  const hist = histories[k]!;
  const histTs = hist.map((x) => x.t);
  for (const h of horizons) {
    const ts = s.endMs - h * HOUR;
    const i = indexAtOrBefore(closeTs, ts);
    const j = indexAtOrBefore(histTs, ts);
    if (i < 0 || ts - closes[i]!.ts > 2 * MIN || j < 0 || ts - hist[j]!.t > 10 * MIN) continue;
    const market = hist[j]!.p;
    // Strikes the market already treats as settled say nothing about the model.
    if (!(market > 0.02 && market < 0.98)) continue;
    obs.push({ h, oos: s.endMs >= splitMs, y: s.resYes, market, spot: closes[i]!.price, strike: s.strike, ts, endMs: s.endMs });
  }
});

const volCache = new Map<string, number | null>();
function volAt(ts: number, windowH: number): number | null {
  const key = `${ts}:${windowH}`;
  if (!volCache.has(key)) {
    const i = indexAtOrBefore(closeTs, ts);
    const j = indexAtOrBefore(closeTs, ts - (windowH + 1) * HOUR);
    volCache.set(key, i < 0 ? null : hourlyVol(closes.slice(Math.max(0, j), i + 1), windowH * HOUR));
  }
  return volCache.get(key)!;
}

function predict(o: Obs, p: Params, profile: VolProfile): number | null {
  const vol = volAt(o.ts, p.windowH);
  if (vol === null) return null;
  return fairValue({ spot: o.spot, strikeUsd: o.strike, nowMs: o.ts, endMs: o.endMs, hourlyVol: vol * p.volScale, profile, tails: p.tails })!.yes;
}

const clampP = (p: number) => Math.min(1 - 1e-4, Math.max(1e-4, p));
const logLoss = (ys: number[], ps: number[]) => -ys.reduce((a, y, i) => a + (y ? Math.log(clampP(ps[i]!)) : Math.log(1 - clampP(ps[i]!))), 0) / ys.length;
const brier = (ys: number[], ps: number[]) => ys.reduce((a, y, i) => a + (ps[i]! - y) ** 2, 0) / ys.length;

function fit(sample: Obs[], profile: VolProfile): Params {
  let best: { p: Params; loss: number } | null = null;
  for (const windowH of [24, 72, 168])
    for (const volScale of [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5])
      for (const weight of [0, 0.1, 0.2, 0.3])
        for (const ratio of weight === 0 ? [1] : [2, 3, 4]) {
          const p: Params = { windowH, volScale, tails: { weight, ratio } };
          const scored = sample.map((o) => [o.y, predict(o, p, profile)] as const).filter((x) => x[1] !== null);
          const loss = logLoss(scored.map((x) => x[0]), scored.map((x) => x[1]!));
          if (!best || loss < best.loss) best = { p, loss };
        }
  return best!.p;
}

const inProfile = profileFromCloses(closes.filter((c) => c.ts < splitMs));
const fitted = fit(obs.filter((o) => !o.oos), inProfile);
const plain: Params = { windowH: 24, volScale: 1, tails: { weight: 0, ratio: 1 } };
const oos = obs.filter((o) => o.oos && predict(o, fitted, inProfile) !== null && predict(o, plain, inProfile) !== null);

console.log(`Fitted before the split: ${fitted.windowH}h volatility window, scale ${fitted.volScale}, tail weight ${fitted.tails.weight}, tail ratio ${fitted.tails.ratio}.`);
console.log("\nOut of sample, strikes the market priced between 0.02 and 0.98. Lower is better.\n");
console.log("| Hours before close | Strikes | Brier market | Brier plain model | Brier fitted model | Log loss market | Log loss plain | Log loss fitted |");
console.log("|---|---|---|---|---|---|---|---|");
for (const h of horizons) {
  const rs = oos.filter((o) => o.h === h);
  if (rs.length < 10) continue;
  const ys = rs.map((o) => o.y);
  const mk = rs.map((o) => o.market);
  const pl = rs.map((o) => predict(o, plain, inProfile)!);
  const ft = rs.map((o) => predict(o, fitted, inProfile)!);
  console.log(`| ${h} | ${rs.length} | ${brier(ys, mk).toFixed(4)} | ${brier(ys, pl).toFixed(4)} | ${brier(ys, ft).toFixed(4)} | ${logLoss(ys, mk).toFixed(4)} | ${logLoss(ys, pl).toFixed(4)} | ${logLoss(ys, ft).toFixed(4)} |`);
}

console.log("\nCalibration, out of sample: average forecast vs how often YES happened.\n");
console.log("| Forecast band | Model n | Model said | Happened | Market n | Market said | Happened |");
console.log("|---|---|---|---|---|---|---|");
for (const [lo, hi] of [[0, 0.1], [0.1, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 1]] as const) {
  const m = oos.filter((o) => { const p = predict(o, fitted, inProfile)!; return p >= lo && p < hi; });
  const k = oos.filter((o) => o.market >= lo && o.market < hi);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN).toFixed(3);
  console.log(`| ${lo}–${hi} | ${m.length} | ${avg(m.map((o) => predict(o, fitted, inProfile)!))} | ${avg(m.map((o) => o.y))} | ${k.length} | ${avg(k.map((o) => o.market))} | ${avg(k.map((o) => o.y))} |`);
}

console.log("\nDoes disagreement with the market predict the outcome? Mean of (outcome − market) signed in the model's direction.\n");
console.log("| Gap at least | Strikes | Mean edge | t |");
console.log("|---|---|---|---|");
for (const g of [0.03, 0.05, 0.1]) {
  const e = oos
    .map((o) => ({ d: predict(o, fitted, inProfile)! - o.market, r: o.y - o.market }))
    .filter((x) => Math.abs(x.d) >= g)
    .map((x) => Math.sign(x.d) * x.r);
  if (e.length < 10) continue;
  const m = e.reduce((a, b) => a + b, 0) / e.length;
  const sd = Math.sqrt(e.reduce((a, b) => a + (b - m) ** 2, 0) / (e.length - 1));
  console.log(`| ${(100 * g).toFixed(0)}c | ${e.length} | ${(100 * m).toFixed(2)}c | ${(m / (sd / Math.sqrt(e.length))).toFixed(2)} |`);
}

if (args["write-params"]) {
  const profile = profileFromCloses(closes);
  const p = fit(obs, profile);
  writeFileSync(
    PARAMS_PATH,
    JSON.stringify({ fittedFrom: args.from, fittedTo: args.to, windowHours: p.windowH, volScale: p.volScale, tails: p.tails, profile: profile.map((v) => +v.toFixed(4)) }, null, 2) + "\n",
  );
  console.error(`wrote ${PARAMS_PATH}`);
}
