/**
 * Valid isolated Paper Trading Ledger. In-memory, resets on bot startup.
 */

const STARTING_BALANCE = 100.00;
let simulated_usdc_balance = STARTING_BALANCE;
let totalMockTrades = 0;
let winCount = 0;
let lossCount = 0;

export function getPaperBalance(): number {
  return simulated_usdc_balance;
}

export function deductPaperBalance(amount: number): number {
  simulated_usdc_balance -= amount;
  return simulated_usdc_balance;
}

export function addPaperBalance(amount: number): number {
  simulated_usdc_balance += amount;
  return simulated_usdc_balance;
}

export function recordMockTrade() {
  totalMockTrades++;
}

export function recordMockWin() {
  winCount++;
}

export function recordMockLoss() {
  lossCount++;
}

export function getPaperStats() {
  return {
    totalMockTrades,
    winCount,
    lossCount,
    grossPnl: simulated_usdc_balance - STARTING_BALANCE,
    currentBalance: simulated_usdc_balance
  };
}
