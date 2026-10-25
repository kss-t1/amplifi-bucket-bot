/**
 * BTC/USDT from Binance, the exchange Polymarket resolves BTC daily strikes on.
 *
 * Spot comes from the aggTrade stream, so a move is seen within milliseconds.
 * Volatility needs 72h of history, which comes from 1m klines over REST: seeded
 * at startup and topped up every minute.
 */
import type { PricePoint } from "../../common/src/vol-gate.ts";
import { fetchWithTimeout } from "../../common/src/http.ts";
import type { Logger } from "../../common/src/amplifi-client.ts";

const REST = "https://api.binance.com/api/v3/klines";
const WS = "wss://stream.binance.com:9443/ws/btcusdt@aggTrade";
const MIN = 60_000;

/** Binance kline row → close stamped at the end of its minute. */
export function klineToPoint(row: unknown[]): PricePoint {
  return { ts: Number(row[6]) + 1, price: Number(row[4]) };
}

export class BinanceFeed {
  spot: number | null = null;
  spotAtMs = 0;
  closes: PricePoint[] = [];
  private ws: WebSocket | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly historyMs: number,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    await this.loadCloses(Date.now() - this.historyMs);
    this.timer = setInterval(() => {
      const last = this.closes[this.closes.length - 1]?.ts ?? Date.now() - this.historyMs;
      this.loadCloses(last).catch((e) =>
        this.logger.warn("binance klines refresh failed", { err: String(e) }),
      );
    }, MIN);
    this.connect();
    // A socket can stall without closing; BTC trades many times a second.
    this.watchdog = setInterval(() => {
      if (this.spotAtMs && Date.now() - this.spotAtMs > 15_000) this.ws?.close();
    }, 5_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.ws?.close();
  }

  private async loadCloses(fromMs: number): Promise<void> {
    const fresh: PricePoint[] = [];
    for (let t = fromMs; t < Date.now() - MIN; t += 1000 * MIN) {
      const res = await fetchWithTimeout(
        `${REST}?symbol=BTCUSDT&interval=1m&startTime=${t}&limit=1000`,
      );
      if (!res.ok) throw new Error(`klines ${res.status}`);
      const rows = (await res.json()) as unknown[][];
      for (const r of rows) {
        const p = klineToPoint(r);
        if (p.ts <= Date.now()) fresh.push(p);
      }
      if (rows.length < 1000) break;
    }
    const lastTs = this.closes[this.closes.length - 1]?.ts ?? 0;
    for (const p of fresh) if (p.ts > lastTs) this.closes.push(p);
    const cutoff = Date.now() - this.historyMs - 2 * 60 * MIN;
    while (this.closes.length && this.closes[0]!.ts < cutoff) this.closes.shift();
  }

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(WS);
    this.ws = ws;
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { p?: string };
        const p = Number(msg.p);
        if (p > 0) {
          this.spot = p;
          this.spotAtMs = Date.now();
        }
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (this.stopped) return;
      this.logger.warn("binance ws closed, reconnecting");
      setTimeout(() => this.connect(), 1000);
    };
    ws.onerror = () => ws.close();
  }
}
