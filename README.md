# btc-bounce-bot

A make.fun bars-replay bot for the `btc-race-24h` competition: it trades Coinbase Wrapped BTC
(`CBBTC`) against USDC, minute by minute, on a replay of Solana DEX (Orca Whirlpool) pool state.
Long only, one position at a time, cash earns nothing.

The bot speaks `agent-fun/bars-replay/v1` newline-delimited JSON on stdin/stdout: the harness sends
`hello` once, then one `batch` per minute (the bar that just closed, the fills of the previous
reply, the account), and the bot answers every batch with exactly one `reply` carrying its orders.
Orders decided on bar *k* fill at bar *k+1*'s open.

## Strategy, bar by bar

Everything is deterministic: no wall clock, no randomness, no environment, every amount a `BigInt`
of micro-USDC. The only inputs are the bars the harness sends. `main.ts` keeps a growing array of
`CBBTC` closes and uses `state.seq` (the batch/bar index) as its clock.

1. **Exit first.** If a position is held, its gain in bps over its cost is computed with
   `state.value()` at the latest close, so the 4 bps fee and the pool's 0.04% fee stay inside the
   cost. The whole position is sold when any of these holds:
   - gain `>= +90` bps (take profit),
   - gain `<= -70` bps (stop),
   - 60 bars held since the entry bar (time stop).
   After an exit the bot sets a cooldown of 10 bars.
2. **Entry.** Only when flat, out of cooldown, and the last bar dropped at least 40 bps:
   `dropBps = (prevClose - close) / prevClose * 10_000 >= 40`. It buys 50% of cash
   (`cash * 5000 / 10000`), `max_slippage_bps: 150`. The entry bar is remembered for the time stop.
   The idea: cbBTC mean-reverts after one-minute capitulation wicks, and a trade has to catch more
   than a round trip's ~26 bps of fees, slippage and impact — a 40 bps drop with a +90 bps target
   clears that.
3. **Late probe.** If the position is still flat, nothing has ever filled, and `state.seq >= 1300`,
   the bot buys `max(1 USDC, cash * 200 / 10000)` with `max_slippage_bps: 10000`. This is the
   guardrail probe: it guarantees at least one filled order (the race's guardrails want at least one
   trade) even on a window with no qualifying drop. It is sent at most once — `probed` is sticky.

The bot is long only, never holds more than one position, and sizes at half the cash so a 25%
drawdown guardrail is not reachable. Buying and holding a falling bar plus the round trip's costs
would lose money, so the bot sits in cash and only pays costs when a drop looks like capitulation.

## Grading it locally

The kit ships the dev window and the exact harness. With Node 22+ (26 for running `.ts` locally):

```
export MAKEFUN_API_KEY=$(cat ~/.config/makefun/api_key)
cd /home/ubuntu/makefun/kits/btc-race-24h-20261113-2314-kit
node cli/makefun.mjs grade-local --kit . --bot /home/ubuntu/btc-bounce-bot --driver process --json
```

`grade-local` verifies the kit's files against `kit.json`, re-derives every bar from its samples,
runs the bot twice on the dev window and reports the score (net PnL, trades, drawdown, and whether
the two runs' action logs matched). A run that is deterministic prints the same numbers every time.

## Layout

- `main.ts` — the bot entrypoint (erasable TypeScript, runs under Node's type stripping).
- `vendor/makefun-bars.ts` — the kit's SDK shim, copied byte for byte from the kit.
- `.makefun/owner.json` — the claim file naming the entry's wallet.
- `LICENSE` — MIT, copyright Ineffa.
