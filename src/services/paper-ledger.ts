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

/** Record the cost basis of the current open trade. */
export function recordPrincipal(amount: number) {
  currentTradePrincipal = amount;
}

export function getPrincipal(): number {
  return currentTradePrincipal;
}

/**
 * Standardized Settlement Math:
 * Realized_PnL = Gross_Return - Invested_Principal
 * New_Sim_Balance = Old_Sim_Balance + Realized_PnL
 */
export function settleMockTrade(shares: number, exitPrice: number, isWin?: boolean, principalOverride?: number): { pnl: number, simBalance: number } {
  const principal = principalOverride !== undefined ? principalOverride : currentTradePrincipal;
  let grossReturn = 0;

  if (isWin !== undefined) {
    // Expiration logic: WIN = shares * $1.00, LOSS = $0.00
    grossReturn = isWin ? shares * 1.00 : 0;
  } else {
    // Stop Loss / Profit Lock logic: shares * exit price
    grossReturn = shares * exitPrice;
  }

  const pnl = grossReturn - principal;
  simulated_usdc_balance += pnl;
  
  totalMockTrades++;
  if (pnl > 0) winCount++;
  else if (pnl < 0) lossCount++;
  
  if (principalOverride === undefined) {
    currentTradePrincipal = 0; // Only reset if we used the global principal
  }
  
  return {
    pnl,
    simBalance: simulated_usdc_balance
  };
}

export function getPaperStats() {
  const totalClosed = winCount + lossCount;
  const winRate = totalClosed > 0 ? (winCount / totalClosed) * 100 : 0;
  return {
    totalMockTrades, 
    totalClosed,
    winCount,
    lossCount,
    winRate,
    grossPnl: simulated_usdc_balance - STARTING_BALANCE,
    currentBalance: simulated_usdc_balance
  };
}
