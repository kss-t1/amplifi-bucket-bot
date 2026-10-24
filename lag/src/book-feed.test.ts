import { describe, expect, test } from "bun:test";
import { BookFeed, applyLevel, bookFromSnapshot, topOfBook } from "./book-feed.ts";

const quiet = { info() {}, warn() {}, error() {} };

describe("order book state", () => {
  test("top of book picks the highest bid and lowest ask whatever the order", () => {
    const book = bookFromSnapshot(
      [{ price: "0.90", size: "10" }, { price: "0.94", size: "25" }],
      [{ price: "0.99", size: "5" }, { price: "0.95", size: "40" }],
    );
    expect(topOfBook(book)).toEqual({ bestBid: 0.94, bidSize: 25, bestAsk: 0.95, askSize: 40 });
  });

  test("a zero-size level is removed and differently spelled prices share a level", () => {
    const book = bookFromSnapshot([{ price: "0.94", size: "25" }], [{ price: "0.95", size: "40" }]);
    applyLevel(book, "SELL", "0.950", "0");
    expect(topOfBook(book)).toBeNull();
    applyLevel(book, "SELL", "0.96", "7");
    expect(topOfBook(book)!.bestAsk).toBe(0.96);
  });

  test("feed applies book snapshots and price changes and reports which token moved", () => {
    const moved: string[] = [];
    const feed = new BookFeed(quiet, (id) => moved.push(id));
    feed.handle(
      JSON.stringify([
        { event_type: "book", asset_id: "A", bids: [{ price: "0.94", size: "25" }], asks: [{ price: "0.95", size: "40" }] },
      ]),
    );
    feed.handle(
      JSON.stringify({
        event_type: "price_change",
        price_changes: [
          { asset_id: "A", price: "0.95", size: "0", side: "SELL" },
          { asset_id: "A", price: "0.97", size: "3", side: "SELL" },
          { asset_id: "B", price: "0.5", size: "3", side: "BUY" },
        ],
      }),
    );
    feed.handle("PONG");
    expect(moved).toEqual(["A", "A"]);
    expect(feed.top("A")).toEqual({ bestBid: 0.94, bidSize: 25, bestAsk: 0.97, askSize: 3 });
    expect(feed.top("B")).toBeNull();
  });
});
