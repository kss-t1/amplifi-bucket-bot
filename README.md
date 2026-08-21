# Bucket bot

Opens leveraged YES/NO positions on Polymarket's daily _Bitcoin above $X_
markets when the qualifying side trades in one of three high-conviction
price buckets: **0.90–0.95**, **0.95–0.97**, **0.97–0.99**, or **0.99+**.

The bet is that the same statistical edge identified in the
[BTC daily-above 500ms backtest](https://www.notion.so/BTC-daily-above-__-markets-35d231194dc380839c51c738d4506418)
— ~91% win rate at 0.90–0.95, ~99% at 0.97+ — translates to live Amplifi
trading once leverage is layered on. Three production bots run in parallel
with $100 each (one per bucket), and the one chosen for the **above/below
restriction** delta-neutralizes itself against BTC by splitting each day's
budget 50/50 between strikes above and below spot.

## Strategy

For each of the next 6 daily-above events (the soonest-resolving carries
the most capital — head-weighted), the bot:

1. Pulls the event from Gamma via slug `bitcoin-above-on-{month}-{day}`.
2. Infers current BTC by picking the strike whose YES price is closest to
   $0.50 — the at-the-money strike of an Amplifi-style binary.
3. For each strike, evaluates the **qualifying side**:
   - strike < BTC → bet YES (it's already in the money)
   - strike > BTC → bet NO (BTC needs to climb to break it)
   - the ATM strike itself is skipped — its prices are nowhere near the
     0.90+ bucket band anyway.
4. Keeps only strikes whose qualifying side falls in the bot's allowed
   bucket(s). Allocates the day's budget equally across them.

Day-budget weights:

| Days to expiry | Share of total capital |
| -------------- | ---------------------- |
| <24h           | 40%                    |
| 24–48h         | 25%                    |
| 48–72h         | 12.5%                  |
| 72–96h         | 7.5%                   |
| 96–120h        | 7.5%                   |
| 120–144h       | 7.5%                   |

If a day has no qualifying markets, **its share is held as free cash** —
no rebalancing into other days. Predictable exposure trumps maxing out
deployment.

The **`ABOVE_BELOW_RESTRICTED`** toggle, when on, splits each day's budget
50/50 between strikes above current BTC (NO bets) and strikes below (YES
bets) — equal nominal on each side, regardless of how many markets are in
each half. If a half is empty, that half stays as cash.

Positions are held to resolution; the spec calls for daily rebalancing
"as day-1 markets resolve", which naturally happens via Amplifi's
`MarketResolutionSyncService` redeeming positions at $1.00 / $0.00 through
the CTF. The bot's next poll cycle sees the freed margin and opens new
slots for the newly-visible 6th day.

### Leverage per bucket

Defaults are the **maker-optimal** lift from the 500ms orderbook backtest
(production-mode, $100 nominal, all-entries):

| Bucket    | Leverage | Backtest ROE | Survival |
| --------- | -------- | ------------ | -------- |
| 0.90–0.95 | 4x       | 10.7%        | 78.8%    |
| 0.95–0.97 | 7x       | 11.4%        | 80.2%    |
| 0.97–0.99 | 10x      | 11.8%        | 95.7%    |
| 0.99+     | 10x      | 11.8%        | 95.7%    |

The 0.97+ band was historically a single bucket — the backtest does not yet
distinguish 0.97–0.99 from 0.99+, so defaults match. Override per-profile
via `LEVERAGE_97_99` and `LEVERAGE_99_PLUS`. Setting `LEVERAGE_97_PLUS`
alone (the legacy env) applies to both upper buckets.

### Maker-first order placement

The bot posts a GTC limit order at the live CLOB best-bid via Amplifi's
`/polymarket/orders` endpoint (`AmplifiClient.placeLimitOrder`) instead of
crossing the spread with a market order. The harvester bot's empirical
measurement on these markets put **~97% of fills as maker**, which is
why the leverage trios above lean on the maker row of the 500ms backtest
without an explicit taker-fee discount.

Sequence per target:

1. Fetch the live CLOB book for the side we want (NO bets read the
   `complementTokenId` book; YES bets read the canonical `tokenId` book).
2. Round the best-bid down to the per-market tick (`floorToTick`) and
   place a leveraged GTC limit at that price.
3. Order rests as `RESTING`; once someone hits it, it becomes `FILLED`
   with a `positionId`. The slot then holds to resolution as before.
4. If the order sits unfilled for `MAKER_MAX_RESTING_AGE_SEC` (default
   600s = 10 min) **and** the live best-bid has moved up by ≥1 tick,
   the bot cancels and the next poll re-places at the refreshed price.
   Capped at `MAKER_MAX_REPRICES_PER_SLOT` cycles (default 5) to bound
   spend in pathological drift.

If a market's bid side is one-sided (no resting bids), the bot skips the
slot rather than become the only bid with no counterparty — the next
poll retries. Same pattern the harvester bot uses.

### Take-profit + margin recycling

Every filled slot gets a TP limit-sell so capital can be redeployed
before resolution. Two modes:

- **`TP_ROE_PCT` set** — ROE-on-collateral pricing:

  ```
  tpPrice = fillPrice × (1 + TP_ROE_PCT / (leverage × 100))
  ```

  Ceiled UP to the side's tick.

- **`TP_ROE_PCT` unset (default)** — fixed TP at `0.999` (see
  `DEFAULT_TP_PRICE` in `src/tp.ts`), floored DOWN to the side's tick
  so it never lands above the CLOB cap of `1 − tickSize`. The slot
  books most of the profit on positions that would otherwise ride to
  expiry.

TPs are registered via `POST /polymarket/positions/:id/take-profit`.
Once the TP fires the position closes on-chain and the slot drops out
of state on the next reconcile pass. The allocator's day-weight /
bucket / leverage rules then naturally redeploy the freed margin into
a fresh slot — no separate plumbing needed.

If `setTakeProfit` 400s (most commonly because the market already
moved above the TP and the backend's `tp > bestBid` guard trips), the
bot retries under exponential backoff (30s → 10min, up to 10 attempts)
and otherwise lets the position ride.

**Active exit (`TP_ACTIVE_EXIT=true`, opt-in).** With an ROE target set,
the `tp > bestBid` rejection above means the market is already offering
≥ our target profit. For a volume-first fleet, set `TP_ACTIVE_EXIT=true`
to **close at market** on that rejection — banking the gain and recycling
the collateral now — instead of escalating to a resting `0.999` TP that
sits behind the deep-ITM sell wall and rides to resolution (dead capital,
no volume). Crossing the spread costs a minuscule deep-ITM taker fee.
Default `false` preserves the ride-to-resolution behavior.

### Optional taker-mode order placement

Set `ORDER_MODE=taker` to switch from the maker-first GTC flow to immediate
FAK market opens via `/polymarket/positions/open`. High-bucket BTC daily-above
markets have minuscule Polymarket taker fees (the fee scales as `p · (1−p)`
which collapses near the tails), so the immediate-fill advantage often
outweighs the maker rebate — and there's no resting-order race window for
the price to drift away before the slot fills.

Taker slots land with `positionId` populated immediately; reprice logic is
inert (the slot has no `orderId`). The take-profit + reconcile passes work
the same as for filled maker slots.

`ORDER_MODE=maker` (the default) is the legacy GTC behavior.

### Optional entry-price ceiling + interest-aware ROI gate

The deep-ITM band is exactly where leveraged longs lose money on the
interest cost of carry: the per-share upside `1 − p` shrinks faster than
the daily borrow rate. Two knobs guard this band:

- `MAX_ENTRY_PRICE=0.996` — hard ceiling. Any strike whose qualifying-side
  mid-price sits at or above this is skipped entirely. The capital
  earmarked for that day stays idle.
- `MIN_ROI_AFTER_INTEREST_PCT=2` — minimum expected ROI on collateral
  through to resolution, after subtracting borrow interest. Computed as
  `L·(1−p)/p − (L−1)·apr·(hours/8760)` where `L` is the bucket's
  leverage. When this gate is on, the bot reads live `borrowRate()` from
  the lending pool (`LENDING_POOL_ADDRESS`) every 5 min and refuses
  opens that don't clear the floor. Below 0.99 the natural upside is so
  much bigger than any reasonable APR that the gate is a no-op; in
  practice it only bites in the 0.99-to-`MAX_ENTRY_PRICE` band.

When the ROI fetch fails (e.g. RPC flake) the bot fails CLOSED — it skips
new placements for that cycle and tries again on the next poll. Existing
positions are unaffected.

### Optional bucket-stability gate

`BUCKET_STABILITY_WINDOW_MIN=15` makes the bot wait until a market has
been continuously observed in its target bucket for the configured
number of minutes before it opens. Any bucket transition (e.g. a brief
dip from 0.99+ to 0.97–0.99) resets the timer. The buffer is persisted
to the state file so a quick restart doesn't reset every counter; longer
pauses (> 3× the poll interval) invalidate the streak via a
`maxGapMs` check.

Designed to filter out markets that briefly grace a high bucket and
bounce back out — exactly the "got in at 0.97, slipped back to 0.90,
liquidated" failure mode the leverage table was tuned to avoid.

### Optional per-position collateral cap

`MAX_POSITION_COLLATERAL_USD=15` clamps each target's collateral to a
ceiling. Days with few qualifying strikes won't concentrate the day's
budget into one slot; surplus capital simply stays idle. Default unset
(no cap → even share across qualifying strikes within the day's budget).

### Drift stop-loss (`STOP_LOSS_*`)

The vol gate only blocks NEW opens; an already-open leveraged position has no
downside exit between "TP above" and "liquidation below", so a slow grind
(each window individually calm) rides the full distance to the liquidation
trigger and costs ~100% of margin plus the liquidation penalty (the
2026-07-17 cluster: 17 liqs over a 13h BTC drift that never moved >1.1%/1h).
The stop-loss closes a filled leveraged slot at market once it has lost a
configurable fraction of its initial margin:

```
STOP_LOSS_ENABLED=true                  # default false
STOP_LOSS_MARGIN_FRACTION=0.5           # in (0,1); 0.5 ≈ halfway to the liq trigger
STOP_LOSS_SKIP_NEAR_RESOLUTION_MIN=45   # hand the endgame to the backend engine
```

Mechanics (see `common/src/drift-stop.ts`): the position is marked at
its executable bid (NO side = `1 − YES best ask`); the stop fires only on the
**2nd consecutive** breaching poll (dip-and-recover is routine deep-ITM); 1x
slots are exempt (nothing to outrun); missing book data fails OPEN; a Gamma
outage skips the pass loudly instead of silently suspending protection; and a
fired stop arms `REENTRY_COOLDOWN_MS` (when configured) plus skips new
placements for the remainder of that poll so freed capital isn't immediately
re-armed into the same move.

### Optional time-to-resolution filter

Set `MAX_HOURS_TO_RESOLUTION` to skip markets whose resolution time is
beyond a configurable threshold. The filter runs in `pollOnce` right
after the Gamma fetch, nulling out events past the cutoff so the
downstream allocator treats them as "no event" and leaves that day's
budget unspent until the event enters the window.

Empirical liquidation rates across simulated bucket-bot fills show a
cliff at 36h:

| Time-to-resolution at open | Liquidation rate |
| -------------------------- | ---------------- |
| <24h                       | ~10%             |
| 24-36h                     | ~13%             |
| 36-48h                     | ~33%             |
| 48-72h                     | ~50%             |
| 72h+                       | ~67%             |

Gating entries to `<= 36h` cuts the tail without giving up most of the
upside — the daily bond's largest move is in the final 24h regardless
of where entry happened. Leave unset / blank to trade every day in the
`DAYS` window.

#### Per-bucket overrides (`MAX_HOURS_*` / `MIN_HOURS_*`)

`MAX_HOURS_TO_RESOLUTION` sets a single coarse cutoff for the whole fleet,
but the time-toxicity is **bucket-specific**. Live-data analysis (see
`.claude/rules/bucket-bot-framework.md`) shows, by entry-bucket × hours-to-
resolution at open:

- **0.97-0.99** is +EV only when opened **≤ ~18h** out; beyond that it bleeds.
- **0.90-0.97** (shallow) and **0.99+** stay +EV up to **~24h**.
- **All** buckets are negative at **24h+**.

So each bucket has its own optional `MAX_HOURS_<band>` and `MIN_HOURS_<band>`
(`90_95`, `95_97`, `97_99`, `99_PLUS`), each defaulting to the global
`MAX_HOURS_TO_RESOLUTION` / `MIN_HOURS_TO_RESOLUTION`. Recommended:

```
MAX_HOURS_TO_RESOLUTION=24   # default for shallow + 0.99+
MAX_HOURS_97_99=18           # tighter gate on the deep bucket
```

Mechanics: the **coarse event-level filter** in `pollOnce` drops whole events
past the _loosest_ per-bucket cap (so it never over-drops); the **allocator**
then applies the precise per-bucket `MAX`/`MIN` per strike (a strike's bucket
is set by its entry price, but all strikes in an event share its resolution
time). A `MIN_HOURS_*` floor drops entries opened too close to settlement,
where the book thins/clears and fills + liquidation triggers get noisy.
Backwards-compatible: setting only the global behaves exactly as before.

## Production layout — 3 bots, $100 each

Three separate `.env` profiles, each with its own EOA + state file.
Operator's choice which profile carries the restriction. Per the spec,
exactly one of the three runs `ABOVE_BELOW_RESTRICTED=true`.

```
bucket/.env.90-95     BUCKETS=0.90-0.95   LEVERAGE → 4x
bucket/.env.95-97     BUCKETS=0.95-0.97   LEVERAGE → 7x
bucket/.env.97-plus   BUCKETS=0.97+       LEVERAGE → 10x  (alias: 0.97-0.99 + 0.99+)
```

Run with explicit env files (bun auto-loads `.env` from cwd by default; use
`--env-file` to point at one of the profiles):

```bash
bun --env-file=bucket/.env.90-95 bucket/src/index.ts
bun --env-file=bucket/.env.95-97 bucket/src/index.ts
bun --env-file=bucket/.env.97-plus bucket/src/index.ts
```

Each instance reads its own state file (`STATE_FILE` env, mode-aware
defaults) so dry-run experiments don't leak into live state.

## Setup

```bash
cp bucket/.env.example bucket/.env.90-95
# fill in BOT_PRIVATE_KEY (cast wallet new), BOT_ADDRESS, AMPLIFI_API_BASE
# adjust BUCKETS / LEVERAGE_* per profile
```

**Operator funds the bot's Amplifi balance up front — the bot never
auto-deposits.** Open the bot's Amplifi wallet (one-time POST to
`/polymarket/wallet`) and deposit USDC.e via the standard EIP-712 deposit
flow before starting the bot. No POL needed on the bot's EOA at any point
— Amplifi's deposit-EOA pays gas. Top-ups between runs are also
operator-driven.

**Per-day budgets scale off LIVE equity, not the initial deposit.** Each
poll the bot reads its current equity (`/polymarket/balance` →
`equityFormatted` = portfolio mark-to-market minus on-chain debt) and
uses that figure as the allocator basis. So a losing streak shrinks
subsequent bet sizes (no more "risking the same absolute notional on a
halved account"), and a winning streak grows them. Existing open slots
ride to resolution at the size they were placed at — only newly-deployed
slots see the rescaled budget. `TOTAL_CAPITAL_USD` is kept as the
dry-run / planning default and as the operator's mental starting figure;
live-mode allocation no longer reads it.

## Reconciliation

State is keyed by `(eventSlug, marketSlug, outcome)` so restarts dedupe
correctly. Each poll cycle re-queries Amplifi's pipeline endpoint
(`/polymarket/pipeline/<botAddress>`) and drops any state entry whose
positionId is no longer in the OPEN set — that's the bot's hook for "day-1
resolved, capital is free". The freed slot becomes eligible for redeployment
on the next allocator pass.

## Notes / caveats

- **Markets must be ingested on the Amplifi VM.** If a daily-above market
  hasn't been picked up by `MarketAutoIngestService`, the bot logs
  `skip: market not on amplifi yet` and moves on. BTC dailies normally
  qualify on volume but a fresh-issued strike may take a few minutes.
- **No mid-day churn.** Once opened, a slot is held to resolution — even
  if its price drifts out of the bucket. The strategy explicitly trades
  daily resolution churn for a stable allocation; aggressive close-on-drift
  would re-introduce taker fees on every wobble.
- **`pollIntervalMs` defaults to 60s.** Faster polling buys nothing — the
  resolution boundary is fixed at noon ET, and Gamma's outcomePrices
  update on the order of minutes, not seconds.
- **No backtest harness yet.** The strategy was vetted via the
  `scripts/btc-sim/` 500ms simulator on historical orderbook snapshots
  (see Notion writeup). Live PnL should be compared against the maker $100
  row of that analysis to gauge taker-fee + slippage drag.
