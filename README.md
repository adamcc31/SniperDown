# SniperDown - Polymarket 5m Bot

**SniperDown** is a specialized, automated trading bot built exclusively for Polymarket's 5-minute binary markets. It utilizes a strict, single-directional "DOWN-token" strategy, optimized through extensive backtesting to capitalize on microstructure inefficiencies in high-frequency trading windows.

## Core Architecture & Strategy

The bot abandons traditional two-way trading in favor of a unified **Down-Only Strategy**, leveraging specific price action behaviors:

1. **Direction**: DOWN token strictly.
2. **Entry Window**: `[0.80 - 0.84]` (Buys only when the DOWN token trades within this specific strike band).
3. **Profit Lock**: `0.99` with built-in slippage guards to ensure FAK (Fill-And-Kill) execution.
4. **Stop Loss**: `0.50` absolute cutoff to mitigate catastrophic tail risks.

This strategy requires no predictive modeling but rather exploits structural odds alignment and adverse selection protection mechanisms within 5m windows.

## Telegram Telemetry & Dry Run Mode

SniperDown features a comprehensive, memory-based **Paper Trading System** capable of simulating live capital conditions:
- **Dry Run Emulation**: Fully intercepts CLOB executions, projecting outcomes without gas consumption or risk.
- **Global Balance Ledger**: Every transaction (and heartbeat) includes a real-time tally of the simulated USDC balance.
- **Kill Switch**: Enforces a strict 48-hour termination sequence in dry-run mode for forensic and statistical review.
- **2-Hour Periodic Summary**: Telemetry broadcasts a rolling breakdown of "Total Executions", "Win/Loss Count", "Gross PnL", and the simulated balance.

## Setup & Deployment

### Environment Configuration
Copy `.env.example` to `.env` and fill in the required credentials. Note that in Dry Run mode, actual capital is not utilized.

```shell
POLYMARKET_SLUG_PREFIX=btc-updown-5m
DRY_RUN_MODE=true

BUY_TRIGGER_PRICE=0.80
MAX_BUY_PRICE=0.84
PROFIT_LOCK_PRICE=0.99
STOP_LOSS_PRICE=0.50
```

### Railway Deployment (Nixpacks)
The application includes a `railway.toml` allowing seamless production deployment via Nixpacks.

```bash
npm install
npm run build
npm run start
```
