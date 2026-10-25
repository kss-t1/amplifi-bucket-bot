/**
 * Polymarket order books for a set of tokens over the market WebSocket.
 *
 * The server accepts one subscription per connection, so changing the token
 * set reconnects. A `book` event replaces a token's book; `price_change`
 * events edit single levels. After a reconnect every book is dropped until its
 * fresh snapshot arrives, so the bot never prices off a book it stopped
 * hearing about.
 */
import type { Logger } from "../../common/src/amplifi-client.ts";

const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const PING_MS = 10_000;

export interface Book {
  bids: Map<string, number>;
  asks: Map<string, number>;
}

export interface Top {
  bestBid: number;
  bidSize: number;
  bestAsk: number;
  askSize: number;
}

interface Level {
  price: string;
  size: string;
}

export function bookFromSnapshot(bids: Level[], asks: Level[]): Book {
  const book: Book = { bids: new Map(), asks: new Map() };
  for (const l of bids) applyLevel(book, "BUY", l.price, l.size);
  for (const l of asks) applyLevel(book, "SELL", l.price, l.size);
  return book;
}

export function applyLevel(book: Book, side: string, price: string, size: string): void {
  const levels = side === "BUY" ? book.bids : book.asks;
  const n = Number(size);
  const key = String(Number(price));
  if (n > 0) levels.set(key, n);
  else levels.delete(key);
}

/** Best bid and ask with their sizes, or null when either side is empty. */
export function topOfBook(book: Book): Top | null {
  let bestBid = -1;
  let bestAsk = 2;
  for (const p of book.bids.keys()) if (Number(p) > bestBid) bestBid = Number(p);
  for (const p of book.asks.keys()) if (Number(p) < bestAsk) bestAsk = Number(p);
  if (bestBid < 0 || bestAsk > 1) return null;
  return {
    bestBid,
    bidSize: book.bids.get(String(bestBid))!,
    bestAsk,
    askSize: book.asks.get(String(bestAsk))!,
  };
}

export class BookFeed {
  private books = new Map<string, Book>();
  private tokens: string[] = [];
  private ws: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  lastMessageAtMs = 0;

  constructor(
    private readonly logger: Logger,
    private readonly onUpdate: (tokenId: string) => void,
  ) {}

  top(tokenId: string): Top | null {
    const b = this.books.get(tokenId);
    return b ? topOfBook(b) : null;
  }

  setTokens(tokens: string[]): void {
    const next = [...new Set(tokens)].sort();
    if (next.join() === this.tokens.join()) return;
    this.tokens = next;
    this.reconnect();
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
  }

  reconnect(): void {
    this.teardown();
    this.books.clear();
    if (this.stopped || this.tokens.length === 0) return;
    // A new socket gets a full silence window, or the watchdog's first check
    // after startup reads the initial 0 as a minute of silence.
    this.lastMessageAtMs = Date.now();
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ assets_ids: this.tokens, type: "market" }));
      this.ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, PING_MS);
    };
    ws.onmessage = (ev) => this.handle(String(ev.data));
    ws.onclose = () => {
      if (this.ws !== ws || this.stopped) return;
      this.logger.warn("polymarket ws closed, reconnecting");
      setTimeout(() => {
        if (this.ws === ws) this.reconnect();
      }, 1000);
    };
    ws.onerror = () => ws.close();
  }

  private teardown(): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  handle(raw: string): void {
    this.lastMessageAtMs = Date.now();
    let events: Record<string, unknown>[];
    try {
      const parsed = JSON.parse(raw);
      events = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return; // PONG
    }
    for (const evt of events) {
      if (evt.event_type === "book") {
        const id = evt.asset_id as string;
        this.books.set(id, bookFromSnapshot((evt.bids as Level[]) ?? [], (evt.asks as Level[]) ?? []));
        this.onUpdate(id);
      } else if (evt.event_type === "price_change") {
        const changed = new Set<string>();
        for (const ch of (evt.price_changes as (Level & { asset_id: string; side: string })[]) ?? []) {
          const book = this.books.get(ch.asset_id);
          if (!book) continue;
          applyLevel(book, ch.side, ch.price, ch.size);
          changed.add(ch.asset_id);
        }
        for (const id of changed) this.onUpdate(id);
      }
    }
  }
}
