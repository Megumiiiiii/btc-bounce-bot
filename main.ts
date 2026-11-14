// make.fun bars-replay bot: a capitulation-bounce scalper on cbBTC (CBBTC), long only, no shorts.
//
// It speaks agent-fun/bars-replay/v1 through the kit SDK shim in ./vendor/makefun-bars.ts: the
// harness sends hello once, then one batch per minute, and every batch is answered with exactly one
// reply carrying the orders decided on that bar. Nothing here reads the wall clock, nothing is
// random (no Math.random, no Date, no environment), and every amount is a BigInt of micro-USDC, so
// two runs of the same window produce the same action log byte for byte.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// ---------------------------------------------------------------- strategy constants (bps = 1/10_000)
const DROP_ENTRY_BPS = 40n; // enter after a one-minute drop of at least 40 bps
const TAKE_PROFIT_BPS = 90n; // sell the whole position at +90 bps over cost
const STOP_LOSS_BPS = 70n; // sell the whole position at -70 bps under cost
const MAX_BARS_HELD = 60; // never hold longer than 60 bars
const COOLDOWN_BARS = 10; // no new entry for 10 bars after an exit
const ENTRY_FRACTION_BPS = 5000n; // a normal entry spends 50% of cash
const BUY_SLIPPAGE_BPS = 150; // bound from the latest close, slippage and impact included
const SELL_SLIPPAGE_BPS = 500; // wide: an exit must never be refused on a gap
// Late probe: never finish with zero filled orders. The guardrail wants at least one trade, and a
// window with no 40 bps drop would otherwise end with none, so the probe is the safety net. It sits
// at bar 1250 rather than at the very end: it needs room to fill at the next open and to be sold
// again by the closing flatten, and it is sticky so it can never be sent twice.
const PROBE_AFTER_SEQ = 1250;
const PROBE_FRACTION_BPS = 200n; // the probe spends 2% of cash ...
const PROBE_MIN_NOTIONAL = 1_000_000n; // ... but at least 1 USDC (micro-USDC)
const PROBE_SLIPPAGE_BPS = 10_000; // the probe must not be refused whatever the open does
const MIN_NOTIONAL = 1_000_000n; // a buy spends at least 1 USDC

// ---------------------------------------------------------------- bot state (one process, one window)
const closes: bigint[] = []; // every CBBTC close seen, in bar order
let entryBar = -1; // bar index the open position was decided on, -1 when flat
let cooldownUntil = -1; // no entry decided on a bar before this index
let everFilled = false; // has any of our orders ever filled?
let probed = false; // has the late probe already been sent?

/** The last bar's one-minute drop in bps: (prevClose - close) / prevClose * 1e4, null before two bars. */
function dropBps(): bigint | null {
  const n = closes.length;
  if (n < 2) return null;
  const prev = closes[n - 2]!;
  const curr = closes[n - 1]!;
  if (prev <= 0n) return null;
  return ((prev - curr) * 10_000n) / prev;
}

/** The position's gain in bps over its cost (fees are inside the cost), null when cost is unusable. */
function gainBps(state: BarsState, qty: bigint, cost: bigint): bigint | null {
  if (cost <= 0n) return null;
  const worth = state.value(SYMBOL, qty); // the latest close's mark, so fees stay in the cost
  return ((worth - cost) * 10_000n) / cost;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];

    // 1. Keep the close history current, and note any fill of ours that already landed.
    const close = state.close(SYMBOL);
    if (close !== null) closes.push(close);
    for (const fill of batch.fills) if (fill.status === 'filled') everFilled = true;

    const position = state.positions.get(SYMBOL);
    const holding = position !== undefined && position.qty > 0n;

    // 2. Exit first: the whole position goes on a take-profit, a stop, or after 60 bars.
    if (holding) {
      const gain = gainBps(state, position.qty, position.cost);
      const held = entryBar >= 0 ? state.seq - entryBar : MAX_BARS_HELD;
      const takeProfit = gain !== null && gain >= TAKE_PROFIT_BPS;
      const stop = gain !== null && gain <= -STOP_LOSS_BPS;
      if (takeProfit || stop || held >= MAX_BARS_HELD) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: position.qty, max_slippage_bps: SELL_SLIPPAGE_BPS });
        cooldownUntil = state.seq + COOLDOWN_BARS;
        entryBar = -1;
      }
      return orders;
    }

    // 3. No trading while a warm-up runs (orders there are rejected as `warmup`).
    if (state.warmingUp) return orders;

    // 4. Entry: a capitulation bar while flat, out of cooldown, half the cash.
    const drop = dropBps();
    if (drop !== null && drop >= DROP_ENTRY_BPS && state.seq >= cooldownUntil) {
      const notional = (state.cash * ENTRY_FRACTION_BPS) / 10_000n;
      if (notional >= MIN_NOTIONAL && notional <= state.cash) {
        orders.push({
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: notional,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        });
        entryBar = state.seq;
        return orders;
      }
    }

    // 5. Late probe: if nothing has ever filled and the window is nearly gone, take a token position
    //    so the entry always holds at least one filled order. It is sent once, never twice.
    if (!everFilled && !probed && state.seq >= PROBE_AFTER_SEQ) {
      const share = (state.cash * PROBE_FRACTION_BPS) / 10_000n;
      const notional = share > PROBE_MIN_NOTIONAL ? share : PROBE_MIN_NOTIONAL;
      if (notional >= MIN_NOTIONAL && notional <= state.cash) {
        orders.push({
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: notional,
          max_slippage_bps: PROBE_SLIPPAGE_BPS,
        });
        probed = true;
        entryBar = state.seq;
      }
    }

    return orders;
  },
});
