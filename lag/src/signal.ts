/**
 * Stale-quote trigger for one BTC daily strike, the rule the pmxt backtest
 * validated (see the README's "Lag sniper" section).
 *
 * The fair-value model carries a persistent bias against the market, so the
 * raw gap is not a signal. Each strike keeps an EWMA of (fair − mid) and judges
 * fair value against that baseline, so only a fresh Binance move the book has
 * not caught up with counts. The baseline is read BEFORE it absorbs the current
 * reading, otherwise half of every fresh move would be averaged away.
 */

export type Side = "YES" | "NO";

export interface SignalConfig {
  /** Required edge after the taker fee, in price units (0.01 = 1c). */
  margin: number;
  /** Half-life of the fair-minus-mid baseline. */
  halfLifeSec: number;
  /** Per-side quiet period after a signal, filled or not. */
  cooldownSec: number;
  /** Entry price band, inclusive min and exclusive max. */
  minPrice: number;
  maxPrice: number;
  /** Polymarket crypto taker fee per share is rate × p × (1 − p). */
  takerFeeRate: number;
}

export interface Quote {
  nowMs: number;
  /** Model probability that the strike resolves YES. */
  fairYes: number;
  bestBid: number;
  bestAsk: number;
  /** Shares resting at the best bid / ask. */
  bidSize: number;
  askSize: number;
}

export interface Candidate {
  side: Side;
  /** Price to buy at: the YES ask, or 1 − YES bid for NO. */
  price: number;
  /** Shares available at that price. */
  shares: number;
  /** Fair value of the side after removing the baseline. */
  fair: number;
  edge: number;
  basis: number;
}

export function takerFee(price: number, rate: number): number {
  return rate * price * (1 - price);
}

export class StrikeSignal {
  private basis: number | null = null;
  private basisAtMs = 0;
  private warmMs = 0;
  private readonly coolUntil: Record<Side, number> = { YES: 0, NO: 0 };

  constructor(private readonly cfg: SignalConfig) {}

  update(q: Quote): Candidate[] {
    if (!(q.bestBid > 0) || !(q.bestAsk < 1) || q.bestAsk <= q.bestBid) return [];
    if (!(q.fairYes >= 0 && q.fairYes <= 1)) return [];
    const gap = q.fairYes - (q.bestBid + q.bestAsk) / 2;
    if (this.basis === null) {
      this.basis = gap;
      this.basisAtMs = q.nowMs;
      return [];
    }
    const basis = this.basis;
    const dtSec = Math.max(0, (q.nowMs - this.basisAtMs) / 1000);
    const keep = Math.pow(0.5, dtSec / this.cfg.halfLifeSec);
    this.basis = keep * basis + (1 - keep) * gap;
    this.basisAtMs = q.nowMs;
    this.warmMs += dtSec * 1000;
    if (this.warmMs < this.cfg.halfLifeSec * 1000) return [];

    const fairYes = q.fairYes - basis;
    const out: Candidate[] = [];
    for (const side of ["YES", "NO"] as const) {
      if (q.nowMs < this.coolUntil[side]) continue;
      const price = side === "YES" ? q.bestAsk : 1 - q.bestBid;
      if (price < this.cfg.minPrice || price >= this.cfg.maxPrice) continue;
      const fair = side === "YES" ? fairYes : 1 - fairYes;
      const edge = fair - price - takerFee(price, this.cfg.takerFeeRate);
      if (edge < this.cfg.margin) continue;
      this.coolUntil[side] = q.nowMs + this.cfg.cooldownSec * 1000;
      out.push({
        side,
        price,
        shares: side === "YES" ? q.askSize : q.bidSize,
        fair,
        edge,
        basis,
      });
    }
    return out;
  }
}
