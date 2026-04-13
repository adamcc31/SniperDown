# Phase 2 Staging Checklist

Run with `DRY_RUN_MODE=true` for at least 1 complete market cycle.
All items must be checked before setting `DRY_RUN_MODE=false`.

## Telemetry
- [ ] Telegram fires on BUY_FILLED: amount, price, shares correct
- [ ] Telegram fires on SELL_FILLED: PnL is not 0 and not NaN
- [ ] Telegram fires on auto-redeem WIN: PnL is positive
- [ ] Telegram fires on auto-redeem LOSS: PnL is negative
- [ ] MODE_TAG shows 👻 [DRY RUN] when DRY_RUN_MODE=true
- [ ] MODE_TAG shows 🔴 [LIVE] when DRY_RUN_MODE=false (verify in staging)

## Liquidity Guard
- [ ] "[LiquidityGuard]" log appears before every buyToken attempt
- [ ] Bot skips cycle and logs when volume < BUY_AMOUNT_USD
- [ ] Bot proceeds normally when volume is sufficient
- [ ] On CLOB error, guard fails-open (buy proceeds, error logged)

## Instant Settlement (TTR=0)
- [ ] forceInstantSettlement fires on market switch when old holdings > 0
- [ ] No unhandled promise rejection on market switch
- [ ] forceInstantSettlement does NOT call redeemMarket directly
- [ ] auto-redeem-service handles redemption independently on next interval

## Store Integrity
- [ ] investedPrincipal written to win-bot-state.json after BUY_FILLED
- [ ] investedPrincipal readable in win-monitor before sell executes
- [ ] PnL calculation produces correct result: (shares × price) - principal

## Protected Zones — Regression Check
- [ ] withCredentialRetry still wraps all CLOB calls
- [ ] runWithoutClobRequestLog still suppresses CLOB noise on buy/sell
- [ ] isFakNoMatch regex handles no-liquidity FAK kills correctly
- [ ] WS → orderbook fallback activates when WS price is null

## Final Gate
- [ ] All above items checked
- [ ] One full market cycle completed without crash
- [ ] No unhandled promise rejections in console output
- [ ] Reviewed and signed off by human operator
- [ ] Only then: set DRY_RUN_MODE=false
