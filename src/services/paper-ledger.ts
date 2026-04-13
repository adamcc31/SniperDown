/**
 * Valid isolated Paper Trading Ledger. In-memory, resets on bot startup.
 */

const STARTING_BALANCE = 30.00;
let simulated_usdc_balance = STARTING_BALANCE;
let totalMockTrades = 0;
let winCount = 0;
let lossCount = 0;
let currentTradePrincipal = 0;

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

/** Record the cost basis of the current open trade. */
export function recordPrincipal(amount: number) {
  currentTradePrincipal = amount;
}

export function getPrincipal(): number {
  return currentTradePrincipal;
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
  const totalClosed = winCount + lossCount;
  const winRate = totalClosed > 0 ? (winCount / totalClosed) * 100 : 0;
  return {
    totalMockTrades, // Legacy count
    totalClosed,
    winCount,
    lossCount,
    winRate,
    grossPnl: simulated_usdc_balance - STARTING_BALANCE,
    currentBalance: simulated_usdc_balance
  };
}
