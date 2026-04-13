import { tradingEnv } from "../config/env";
import {
  simulateBuyFillPrice,
  simulateSharesReceived,
  simulateSellFillPrice,
  simulateGrossProceeds,
  realizedPnlFromClobExit as realizedPnlClobExit,
  realizedPnlWin,
  realizedPnlLoss,
} from "../services/sim-math";

type MarketTick = {
  timeRemaining: number;
  price: number;
};

type BuySimulation = {
  sharesOwned: number;
  costBasis: number;
};

type SellSimulation = {
  grossProceeds: number;
  realizedPnl: number;
};

const MARKETS_TO_SIMULATE = 1000;
const MARKET_LIFECYCLE_SECONDS = 300;
const ENTRY_AMOUNT_USD = 10;

function clampPrice(price: number): number {
  return Math.min(0.99, Math.max(0.01, price));
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function generateMarketTicks(): MarketTick[] {
  const ticks: MarketTick[] = [];
  const finalIsWin = Math.random() >= 0.5;
  const drift = finalIsWin ? 0.0004 : -0.0004;
  let price = randomBetween(0.35, 0.65);

  for (let timeRemaining = MARKET_LIFECYCLE_SECONDS; timeRemaining >= 0; timeRemaining -= 1) {
    const noise = randomBetween(-0.03, 0.03);
    price = clampPrice(price + drift + noise);
    ticks.push({
      timeRemaining,
      price: timeRemaining === 0 ? (finalIsWin ? 1.0 : 0.0) : price,
    });
  }

  return ticks;
}

function simulateBuy(amountUsd: number, price: number): BuySimulation {
  const fillPrice = simulateBuyFillPrice(price);
  const sharesOwned = simulateSharesReceived(amountUsd, fillPrice);
  return { sharesOwned, costBasis: amountUsd };
}

function simulateSell(sharesOwned: number, price: number, costBasis: number): SellSimulation {
  const fillPrice = simulateSellFillPrice(price);
  const grossProceeds = simulateGrossProceeds(sharesOwned, fillPrice);
  const realizedPnl = realizedPnlClobExit(grossProceeds, costBasis);
  return { grossProceeds, realizedPnl };
}

function runBacktest(): void {
  let totalTradesExecuted = 0;
  let winningTrades = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  const buyTriggerPrice = tradingEnv.BUY_TRIGGER_PRICE;
  const maxBuyPrice = tradingEnv.MAX_BUY_PRICE;
  const stopLossPrice = tradingEnv.STOP_LOSS_PRICE;
  const profitLockPrice = tradingEnv.PROFIT_LOCK_PRICE;
  const maxTtrSeconds = tradingEnv.MAX_TTR_SECONDS;
  const minTtrSeconds = tradingEnv.MIN_TTR_SECONDS;

  for (let i = 0; i < MARKETS_TO_SIMULATE; i += 1) {
    const ticks = generateMarketTicks();
    let sharesOwned = 0;
    let costBasis = 0;
    let tradePnl = 0;
    let hasEntry = false;
    let closed = false;

    for (const tick of ticks) {
      if (!hasEntry) {
        const inGoldenWindow = tick.timeRemaining <= maxTtrSeconds && tick.timeRemaining >= minTtrSeconds;
        const inBuyBand = tick.price >= buyTriggerPrice && tick.price <= maxBuyPrice;

        if (inGoldenWindow && inBuyBand) {
          const entry = simulateBuy(ENTRY_AMOUNT_USD, tick.price);
          sharesOwned = entry.sharesOwned;
          costBasis = entry.costBasis;
          hasEntry = true;
          totalTradesExecuted += 1;
        }
        continue;
      }

      if (tick.price >= profitLockPrice || tick.price <= stopLossPrice) {
        const exit = simulateSell(sharesOwned, tick.price, costBasis);
        tradePnl = exit.realizedPnl;
        closed = true;
        break;
      }

      if (tick.timeRemaining === 0) {
        tradePnl = tick.price > 0.5 ? realizedPnlWin(sharesOwned, costBasis) : realizedPnlLoss(costBasis);
        closed = true;
        break;
      }
    }

    if (!hasEntry || !closed) continue;

    if (tradePnl > 0) {
      winningTrades += 1;
      grossProfit += tradePnl;
    } else if (tradePnl < 0) {
      grossLoss += tradePnl;
    }
  }

  const winRatePct = totalTradesExecuted > 0 ? (winningTrades / totalTradesExecuted) * 100 : 0;
  const profitFactor = grossLoss === 0 ? Number.POSITIVE_INFINITY : grossProfit / Math.abs(grossLoss);
  const netPnl = grossProfit + grossLoss;

  console.log("=== SNIPERDOWN THETA LAB TEAR-SHEET ===");
  console.log(`Total Markets Analyzed : ${MARKETS_TO_SIMULATE}`);
  console.log(`Total Trades Executed  : ${totalTradesExecuted}`);
  console.log(`Win Rate %             : ${winRatePct.toFixed(2)}%`);
  console.log(`Gross Profit           : ${grossProfit.toFixed(4)}`);
  console.log(`Gross Loss             : ${grossLoss.toFixed(4)}`);
  console.log(`Profit Factor          : ${Number.isFinite(profitFactor) ? profitFactor.toFixed(4) : "Infinity"}`);
  console.log(`Net PnL                : ${netPnl.toFixed(4)}`);
}

runBacktest();
