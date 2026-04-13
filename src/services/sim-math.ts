const BUY_SLIPPAGE_MULTIPLIER = 1.015; // +1.5%
const SELL_SLIPPAGE_MULTIPLIER = 0.985; // -1.5%

export function simulateBuyFillPrice(targetAskPrice: number): number {
  return targetAskPrice * BUY_SLIPPAGE_MULTIPLIER;
}

export function simulateSharesReceived(amountUsd: number, fillPrice: number): number {
  return amountUsd / fillPrice;
}

export function simulateSellFillPrice(bestBidPrice: number): number {
  return bestBidPrice * SELL_SLIPPAGE_MULTIPLIER;
}

export function simulateGrossProceeds(sharesOwned: number, fillPrice: number): number {
  return sharesOwned * fillPrice;
}

export function realizedPnlWin(sharesOwned: number, principalUsd: number): number {
  return (sharesOwned * 1.0) - principalUsd;
}

export function realizedPnlLoss(principalUsd: number): number {
  return -principalUsd;
}

export function realizedPnlFromClobExit(grossProceeds: number, principalUsd: number): number {
  return grossProceeds - principalUsd;
}

