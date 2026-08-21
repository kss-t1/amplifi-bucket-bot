---
paths:
  - "bucket/**"
  - "common/**"
---

# Bucket-bot Config Framework

Empirical findings + predictive model from v1 + v2 bucket-bot runs on amplifi vm018 (Polymarket BTC daily-above markets). Compiled 2026-05-29 from 44h of v2 (5 bots) + ~11 days of v1 (5 bots).

The bot code lives in this repo (`bucket/` + `common/`); it moved out of the amplifi monorepo on 2026-08-21. The data and the backtest/analysis tooling stay in amplifi (the vm018 DB holds every position, loan and PnL row), so a few sections below point at paths over there.

## The 3 invariants

**1. `TP_ROE_PCT × LEVERAGE = K` controls hold time and adverse-selection exposure.**

- v2 bot5 (TP=5, lev 4-5) sits at K≈20-25. Hold avg 365 min (~6h). Liq rate 8%.
- Configs with effective K≈80+ (no TP at lev 8-10, riding to 0.999) have hold ~18h, liq rate 30-40%.
- Constant K → constant hold time → comparable adverse-selection exposure across configs at different leverage.

**2. `MAX_POSITION_COLLATERAL_USD ≤ 10% × starting_capital` is non-negotiable.**

- TP recycles capital fast. Without a hard size cap, positions inflate (free balance grows on each fast close → next open is bigger). v1 bot4 had no cap, max position margin hit $50 on $100 capital → 2 oversized trades wiped $80 of equity. Lost −$66 total despite TP improving per-cycle stats.
- v2 bot5 uses $30 cap (≈19% of equity, ≈30% of starting $100). Stayed profitable.
- Rule of thumb: cap at 10% of _starting_ capital so equity drift doesn't escalate risk.

**3. Higher leverage requires deeper buckets + shorter time windows.**

- Liq buffer ≈ `0.7 / Lev` in price units. Lev 10 has half the buffer of lev 5.
- Compensate by entering closer to resolution (smaller adverse range available) and only in deep-ITM buckets (positive theta strongest there).

## Bucket geometry — empirical liq rates (v1, lev 4-10, no TP)

| Bucket    | Liq rate | Notes                                                                                           |
| --------- | -------: | ----------------------------------------------------------------------------------------------- |
| 0.90-95   |   30-60% | Volatile, far from resolution, avoid at high lev                                                |
| 0.95-97   |   30-50% | Mid-zone — needs maker mode for thin books                                                      |
| 0.97-99   |   10-40% | Workable at moderate lev                                                                        |
| **0.99+** |   **0%** | **Free money. 120+ v1 positions at lev 10: ZERO liqs, 100% win rate. Include in EVERY config.** |

## Per-bucket leverage cliffs (v1+v2, ≤24h-to-resolution, terminal positions)

Compiled 2026-06-03 from all v1+v2 bucket-bot positions (10 EOAs, vm018 `positions`), grouped by **effective leverage × entry-price bucket**, restricted to opens ≤24h to resolution (the `MAX_HOURS_TO_RESOLUTION=24` regime). Confirms invariant 3 empirically: **each bucket has a leverage cliff — a level above which liq rate explodes and net PnL flips negative. The optimum sits just below it.** `vol` = reward-correct traded notional (opens always count = `size`; closes count only when sold on CLOB, not redeemed at resolution).

| Bucket    | Cliff at | Best lev | At best lev: n / liq% / net PnL / vol | Notes                                                            |
| --------- | -------: | -------: | ------------------------------------- | ---------------------------------------------------------------- |
| 0.90-0.95 |    lev 5 |  **2-4** | n13 / 0% / +$18.9 / 1.1k (lev 2)      | lev 5 → 45% liq; lev 6 → 63%. Only lev ≤4 stays 0% liq.          |
| 0.95-0.97 |    lev 6 |  **4-5** | n7 / 0% / +$10.9 / 1.5k               | lev 6 → 44% liq −$83; lev 9 → 71% liq −$80. Carnage above 5.     |
| 0.97-0.99 |    lev 9 |    **8** | n28 / 14% / +$10.2 / 7.0k (max vol)   | lev 9 → 50% liq −$24. lev 8 = most volume AND profitable.        |
| 0.99+     |     none |   **10** | n29 / 0% / +$5.2 / 3.8k               | 0% liq, profitable, max volume. The volume engine. Never reduce. |

**Mechanism:** liq buffer ≈ `0.7/Lev` in price units; the cliff is exactly where the buffer stops covering normal intraday wobble. Deeper bucket → bigger headroom → higher safe leverage.

**The code defaults were corrected to match these optima** (`bucket/src/config.ts`). The old defaults `95_97 ?? 7` and `97_99 ?? 10` ran the 0.95-0.97 and workhorse 0.97-0.99 bands **over their cliffs** — fewer fills, worse PnL, more liqs. New defaults sit one notch below each cliff: **`LEVERAGE_90_95=4`, `LEVERAGE_95_97=5`, `LEVERAGE_97_99=8`, `LEVERAGE_99_PLUS=10`** (90-95 and 99+ were already optimal). The legacy `LEVERAGE_97_PLUS` is still honored as an override for both upper buckets when explicitly set. (Caveat: `positions.pnl` may not fully net loan interest, which costs more at higher lev — so high-lev cells are if anything flattered here; the case for lower leverage is stronger, not weaker.)

**v3 volume fleet leverage ladder (applied 2026-06-03):** a gradient across profiles, every cell below its cliff and near/above break-even, K held ~12-15:

| Profile (bots)   | 0.95-97 | 0.97-99 | 0.99+ | TP% |
| ---------------- | ------: | ------: | ----: | --: |
| V-Safe (1,2)     |       — |       6 |    10 | 2.5 |
| V-Balanced (3,4) |       — |       7 |    10 | 2.0 |
| V-Deep (5,6)     |       — |       8 |    10 | 1.5 |
| V-Max (7,8)      |       5 |       8 |    10 | 2.0 |

## Per-bucket hours-to-resolution gates (v1+v2, bucket × 3h-band EV)

Time-to-resolution at open is the **strongest** PnL driver (liq% ↔ PnL r≈−0.94; leverage only r≈0.37). It is **bucket-specific**, so a single fleet-wide `MAX_HOURS_TO_RESOLUTION` is too blunt — it either forgoes profitable shallow-bucket far-out trades or admits toxic deep-bucket ones. Fleet-wide bucket × 3h-band cumulative PnL gives the per-bucket optima:

| Bucket    | +EV window | Beyond it                                                                                   |
| --------- | ---------- | ------------------------------------------------------------------------------------------- |
| 0.90-0.95 | ≤ ~24h     | 24h+ negative                                                                               |
| 0.95-0.97 | ≤ ~24h     | 24h+ negative                                                                               |
| 0.97-0.99 | ≤ ~18h     | **18-21h is a −$2.26/trade cliff**; the deep bucket only profits opened close to resolution |
| 0.99+     | ≤ ~24h     | 24h+ negative                                                                               |

- **All** buckets bleed at **24h+** — the daily bond's largest adverse move is in the final 24h regardless of entry, but a far-out entry pays carry + sits through more wobble.
- The **0.97-0.99 deep bucket** is the only one whose +EV window is sub-24h. A uniform 12h gate (v2's interim fix) is over-tight: it discards bot5's profitable shallow-bucket 12-24h fills (+$42) to suppress the 0.97-0.99 12-24h loss (−$9).
- Optional **MIN** floor ~3h: the final 0-3h is slightly negative on deep/0.99+ buckets (book thins/clears near settlement → noisy fills + liquidation triggers).

**Implemented** as per-bucket `MAX_HOURS_<band>` / `MIN_HOURS_<band>` (`90_95`/`95_97`/`97_99`/`99_PLUS`) in `bucket/src/config.ts`, each defaulting to the global `MAX_HOURS_TO_RESOLUTION` / `MIN_HOURS_TO_RESOLUTION`. The global stays the coarse event-level cutoff = the loosest per-bucket bound (the max of the caps when ALL buckets are capped, else undefined — an uncapped bucket = infinite horizon, so the pre-filter never drops an event some bucket could still trade); the allocator applies the precise per-bucket cap per strike. Recommended: `MAX_HOURS_TO_RESOLUTION=24` + `MAX_HOURS_97_99=18`.

## TP — counterintuitive findings

- **TP doesn't limit upside.** In volatile binary markets, "untaken upside" is mostly fictional — requires surviving full hold without liq, which often fails. TP harvests paper PnL before volatility can take it.
- **TP improves both win rate AND liq rate at high leverage (v1 bot4 vs bot5 A/B):**
  - bot4 (TP=10%, lev 4-10): 86% win rate, 14% liq rate
  - bot5 (no TP, lev 4-10): 82% win rate, 18% liq rate
  - Same config otherwise. Only difference is TP + 0.99+ bucket inclusion.
- **v1 bot4 still lost catastrophically — but because of position sizing, not TP.** Don't conclude "TP=10% is bad." Conclude "TP without size cap is bad."
- **TP=5% is empirically profitable (v2 bot5).** TP=10% with proper size cap is untested but should also work per the K-invariant.
- **ROE-based TP (`TP_ROE_PCT`) goes inert in deep-ITM buckets at low leverage.** The TP target is `entry × (1 + TP%/100/Lev)`. Two failure modes make it unplaceable, both observed on v2 bot5 (TP=5, lev 2-6) where **6 of 8 open positions had NO placeable TP**:
  1. **Target above $1** — at lev 2 a 5% ROE = a 2.5% price rise; from a deep entry (≥0.98) that lands at 1.01-1.02, an impossible sell price. Logged as `skip: TP price outside (fillPrice, 1)`.
  2. **Target at/below current best bid** — when the market has already moved up to the TP level, the CLOB rejects the resting sell (`takeProfitPrice X must be above current best bid X`).
     Result: those positions get no TP order and **ride to resolution** (fine economically — deep-ITM wins at $1 — but no capital recycling and full hold-to-resolution liq exposure). The TP-recycling benefit only fires on mid-bucket entries (~0.94-0.96) where the ROE target still lands below $1 and above the bid.
  - **Fix (implemented):** `chooseTpDecision` in `bucket/src/tp.ts` layers the fixed-0.999 default _under_ the ROE logic — when the ROE-TP target is out of range it falls back to the fixed 0.999 instead of skipping. For the best-bid case, `ensureTakeProfits` sets `slot.tpForceFixed` on a "must be above current best bid" rejection so the next attempt prices at the higher fixed 0.999 (rests above the bid). Slots only ride to resolution now when even 0.999 is out of range (fill ≥ 1 − tickSize).

## Order mode — maker vs taker (v2 A/B, ~5.6 days)

- **Volume → maker wins, conclusively.** +47% volume, +56% opens, and taker wastes opens on FAK fill-failures (it can't fill thin books — a resting maker limit eventually gets lifted, a FAK needs liquidity at that instant). If volume is the goal, maker.
- **PnL → no taker advantage found anywhere.** Maker net-positive, taker net-negative overall — but maker's edge is mostly that it can fill the thin buckets taker can't. In thick books (0.97-99) the apparent taker "win" was an artifact (a now-fixed dip-and-recover liq + the taker-TP bug below), entries are identical, and 0.99+ came out tied. No bucket or metric where taker clearly beats maker.
- **Verdict: maker is the correct default order mode.** Per-bucket order mode (maker thin / taker thick) was considered but the thick-book taker edge didn't survive scrutiny — not worth building.
- **Taker-TP bug (found 2026-06-02, fixed):** taker opens persisted `fillPrice = 0` (entry price not returned synchronously), and `fillPrice ?? limitPrice` doesn't fall back on 0, so `ensureTakeProfits` silently skipped EVERY taker position — the taker bot ran with **zero** take-profits its whole life (rode everything to resolution). This confounded the A/B PnL side (taker-without-TP vs maker-with-TP). Fix: `tpAnchorPrice` helper guards the 0-trap; taker open anchors `limitPrice` on the targeted mid and leaves `fillPrice` null until a real price is known (mirrors maker). Volume verdict is unaffected.

## Predictive family — all targeting K≈20 with 10% size cap

| Profile            | Lev | TP% | MaxPos | Buckets | MaxH | Pred liq% | Pred ROE/cycle |
| ------------------ | --: | --: | -----: | ------- | ---: | --------: | -------------: |
| Ultra-safe         |   2 |  10 |    $50 | 0.90+   |   36 |       ~3% |            ~3% |
| Safe               |   3 |   7 |    $30 | 0.93+   |   30 |       ~6% |          ~2.5% |
| Balanced (v2 bot5) | 4-5 |   5 |    $30 | 0.95+   |   24 |       ~8% |            ~2% |
| Aggressive         | 7-8 |   3 |    $15 | 0.97+   |   12 |      ~12% |          ~1.2% |
| Volume             |  10 |   2 |    $10 | 0.99+   |    6 |      ~15% |          ~0.5% |

Higher-lev profiles trade per-cycle return for volume throughput. `PnL/volume = drift_bonus / Lev`, so volume max ⇒ higher lev ⇒ lower margin but more throughput.

## Configs proven losing — retire or fix

- **No-TP + high lev (v2 bot1/2/3, lev 7-10):** structurally negative. 30-40% liq rate kills it.
- **Low-lev + no-TP (v2 bot4, lev 4-7):** slow bleed (~-2% ROI/2d). The fix is adding TP, not just lowering lev. "Low leverage alone is safe" is false.
- **High-TP + no size cap (v1 bot4):** catastrophic despite good per-cycle stats. Sizing destroys it.

## Quick reference: setting a new config

1. Pick a risk profile from the family table → get (Lev, TP, Buckets, MaxH).
2. Set `MAX_POSITION_COLLATERAL_USD ≤ 10% × starting_capital`.
3. Always include `0.99+` in `BUCKETS`.
4. ORDER_MODE: `maker` if Buckets includes ≤0.97, `taker` if Buckets are 0.99+ only.
5. Keep `BUCKET_STABILITY_WINDOW_MIN=15` (lower destabilises high-lev configs).
6. Always `MIN_ROI_AFTER_INTEREST_PCT=5` (skips strikes where interest eats the edge).

## Launching a fleet — space the deposits

**Depositing many bots' first-ever deposits back-to-back makes amplifi return `500 Internal server error`.** Each new bot's `POST /polymarket/deposit` triggers a first-time deposit-wallet materialisation (relayer WALLET-CREATE); firing 8 in a tight loop causes server-side burst contention and most fail fast with a generic `500` (the deposit row is never created, so **no funds are pulled** — the failed EOAs keep their full USDC.e). Observed 2026-06-03 launching v3: bots 1-6 `500`'d, bots 7-8 succeeded; re-running with a **15s delay between deposits** landed all 6 cleanly on the first retry. So: deposit the fleet **sequentially with ≥15s spacing**, never in a tight burst. The per-bot pre-deposit USDC.e balance check is the safety net — it throws on a re-run for any bot already funded (balance now 0), so a blind retry can't double-spend. Read each bot's key from its `.env` file, never via argv (see `scripts/depositV3Fleet.ts`).

## Reporting: chart redraw ALWAYS prints the delta-inclusive equity update

Every time the fleet equity chart is updated/redrawn, the reply MUST include the per-fleet equity + consolidated PnL (raw `equity − deposited` PLUS penalties→fee-EOA + interest→pool added back, since those are t1-internal transfers, not losses) **AND the delta since the last check** (Δequity / Δconsolidated, time elapsed, sessions alive). A bare "chart published" with no numbers is a miss — the delta IS the signal the user tracks. Same rule as the btc15m loop ([[btc-15m-bot]] "always include the delta since the last check") and the general [[feedback_include_delta_in_reports]]; it applies to the bucket-fleet chart too. (User correction, 2026-06-24.)

**Every fleet report must ALSO state the number of drift stop-loss hits in the period** (the `stop_loss_closed` events since the previous check — count per fleet or "0 SL hits"), alongside the liquidation count. The SL fire rate is the health signal for the [#2233 drift stop-loss](https://github.com/t1protocol/amplifi/pull/2233): stops replacing liquidations is the mechanism working; stops AND liquidations rising together means moves too fast for the poll cadence. Count via `grep -c "stop_loss_closed" logs/v?.bot?.gen2.log` on vm002 (or the closed-positions delta vs liq delta from the DB). (User standing instruction, 2026-07-19.)

**AND, per SL fire, report the counterfactual verdict** — what would have happened had the stop NOT fired (user standing instruction, 2026-07-20): replay the position's own token from `pm_price_ticks` after the stop time (query template: `/home/kss/fleet-chart/sl-counterfactual.sql`; positionIds from the `stop_loss_closed` log lines):

- post-stop `min(best_bid)` ≤ the stored `positions.liquidation_price` → **would have LIQUIDATED** (stop saved ~half the margin + the penalty);
- trigger never crossed and the market resolved the position's way → **would have RECOVERED to a winner** (a false stop — the stop cost the win);
- market not yet resolved → **PENDING** (re-report at the next check).
  Caveat: the stored `liquidation_price` is the last recomputed threshold; live depth-adjustment only ever RAISES the trigger, so a "survived by <1¢" path should be read as "likely liquidated anyway", not a clean recovery. The running would-have-liquidated : false-stop ratio is the metric that justifies (or retunes) `STOP_LOSS_MARGIN_FRACTION`.

**AND lifetime CLOB volume per fleet + its delta since the last check** (user standing instruction, 2026-07-20) — both in the chat report AND as a series/card on the chart. Volume uses the reward-correct definition ([[bucket-bot-framework]] cliff table `vol` column): opens ALWAYS count = `positions.size`; closes count ONLY when sold on CLOB (`exit_price NOT IN (0, 1)` — `shares_amount × exit_price`), never resolution redemptions. The chart pipeline's `pos_full.sql` (vm002 `/tmp`) emits `open_vol`/`close_vol` per hourly bucket; `rebuild.ts` (persistent copy `/home/kss/fleet-chart/`) accumulates the cumulative per-fleet series (SERIES4, the "Cumulative CLOB volume generated" panel) and the card totals; the `lastVol` baseline in `rebuild.ts` must be bumped each redraw like `last`, so the Δvol prints alongside ΔPnL.

## Restarting / launching the fleet (vm002)

The 21-bot fleet (v2 bot1-5, v3 bot1-8, v4 bot1-8) runs from **`/home/ubuntu/amplifi-bucket-bot`** on vm002, a clone of THIS repo. It moved there on 2026-08-21 from `/home/ubuntu/bucket-bot`, an amplifi monorepo checkout that is kept only as a rollback and no longer runs anything. Also on the box: `/home/ubuntu/amplifi` runs the unrelated `btc15m-tune*` family, so updating `amplifi` does NOT update the bucket bots.

- **Update code:** `cd /home/ubuntu/amplifi-bucket-bot && git pull origin main && bun install`. Safe — the `.env.*`/`.state.*` files are gitignored (untracked), so a pull never clobbers configs or state; verify no `M` tracked files first.
- **Launch:** one detached tmux session per bot, each loading its profile via `--env-file` (Bun does NOT auto-load arbitrary `.env.<name>` — the flag is required):
  `tmux new -d -s bk-v3-bot1 "cd /home/ubuntu/amplifi-bucket-bot && /home/ubuntu/.bun/bin/bun --env-file=bucket/.env.v3.bot1 bucket/src/index.ts 2>&1 | tee -a logs/v3.bot1.gen2.log"`. Each `.env` sets `DRY_RUN=false` (LIVE), `AMPLIFI_API_BASE` (vm018 prod), per-bot `BOT_ADDRESS`/`BOT_PRIVATE_KEY`/`STATE_FILE`, and the risk knobs (BUCKETS, LEVERAGE\_\*, TP_ROE_PCT, MAX_HOURS_TO_RESOLUTION, ORDER_MODE).
- **Canary first, then stagger:** launch ONE bot, wait ~25s, confirm its log shows `amplifi health … envName:"vm018"` + `loaded state` + correct `config {dryRun:false …}` + process ALIVE, THEN launch the other 20 with a ~5s stagger. (No deposit-burst risk on a RESTART — the deposit-burst `500` only hits FIRST-time wallet materialisation; funded bots just resume.)
- **Process count is 2× the bot count:** each tmux runs `sh -c "… bun … | tee"`, so `pgrep -af "env-file=bucket/"` matches BOTH the `sh` wrapper and the `bun` — 21 bots → 42 matches. Count distinct via `tmux ls | grep -c '^bk-'` or `ps -C bun | grep -c index.ts`.
- **Benign log lines (NOT crashes):** `errorMessage: null` (a null field in a logged object) and `takeProfitPrice X must be above current best bid Y` (the ROE-TP-inert case `chooseTpDecision` handles via the fixed-0.999 fallback). Exclude both when scanning logs for real errors.
- **On restart the bot reconciles against LIVE amplifi state** (queries positions/orders/balance), so stale `.state.*.json` self-heals and pre-existing open positions are picked up and managed — no need to reset state files. After a surplus sweep the wallet balance is lower, but sizing is capped by `MAX_POSITION_COLLATERAL_USD`/`TOTAL_CAPITAL_USD` in the `.env`, not the live balance.

## Open empirical questions (untested data points)

- TP=10% **with** proper size cap (predicted profitable, never tested)
- TP=2-3% at high lev (predicted near break-even on PnL/vol but high volume)
- TP=1% extreme-tight (predicted: needs >$200 margin to be worth it)
- Dynamic leverage by hours-to-resolution (lev 3 @ 24h → lev 10 @ 3h)
- Per-bucket ORDER_MODE (maker for 0.95-97, taker for 0.99+ in one bot)

## File locations

- Live bot configs + state: `bucket/.env.{v2,v3,v4}.bot{N}` and `bucket/.state.live.*.json` (vm002: `/home/ubuntu/amplifi-bucket-bot/...`; pre-2026-08-21 copies are under `/home/ubuntu/bucket-bot/bots/bucket/`)
- Position/PnL data: vm018 amplifi DB, `positions` table, filtered by bot EOA
- v2 bot EOAs: bot1 `0xAF3F…7b5a`, bot2 `0x14eD…8e18`, bot3 `0x3eFF…80dd`, bot4 `0x6403…c5a7`, bot5 `0xa99C…E380`
- v1 bot EOAs: bot1 `0x5158…A71a`, bot2 `0xBfb6…6567`, bot3 `0x49B8…60E4`, bot4 `0xf0Bd…2f93`, bot5 `0x1a30…2C42`
