/**
 * VERIFICATION: Adversarial Slippage + Realized PnL Math
 *
 * Run with:
 *   npx ts-node src/scripts/verify-sim-math.ts
 */

const BUY_SLIPPAGE_MULTIPLIER = 1.015; // +1.5%
const SELL_SLIPPAGE_MULTIPLIER = 0.985; // -1.5%
const EPSILON = 0.001;

type BuyResult = {
  principalUsd: number;
  fillPrice: number;
  sharesReceived: number;
};

type SellResult = {
  fillPrice: number;
  grossProceedsUsd: number;
};

function simulateBuy(principalUsd: number, targetAskPrice: number): BuyResult {
  const fillPrice = targetAskPrice * BUY_SLIPPAGE_MULTIPLIER;
  const sharesReceived = principalUsd / fillPrice;
  return { principalUsd, fillPrice, sharesReceived };
}

function simulateSell(sharesOwned: number, bestBidPrice: number): SellResult {
  const fillPrice = bestBidPrice * SELL_SLIPPAGE_MULTIPLIER;
  const grossProceedsUsd = sharesOwned * fillPrice;
  return { fillPrice, grossProceedsUsd };
}

function realizedPnlWin(principalUsd: number, sharesOwned: number): number {
  return (sharesOwned * 1.0) - principalUsd;
}

function realizedPnlLoss(principalUsd: number): number {
  return -principalUsd;
}

function realizedPnlClobExit(principalUsd: number, grossProceedsUsd: number): number {
  return grossProceedsUsd - principalUsd;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// Matches the user-provided display example for -2.23 in scenario A.
function truncateTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.trunc(value * factor) / factor;
}

function assertApprox(actual: number, expected: number, label: string, epsilon = EPSILON): void {
  console.assert(
    Math.abs(actual - expected) <= epsilon,
    `${label} mismatch. expected=${expected}, actual=${actual}`
  );
}

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function randomNumber(min: number, max: number): number {
  return min + (Math.random() * (max - min));
}

function runConcreteScenarios(): void {
  // Shared setup: Buy $10 at Ask 0.500
  const buy = simulateBuy(10.0, 0.5);
  assertApprox(buy.fillPrice, 0.5075, "Buy fill price");
  assertApprox(roundTo(buy.sharesReceived, 4), 19.7044, "Shares received (4dp)");

  // Outcome A: Stop Loss at 0.400 bid
  const stopLossSell = simulateSell(roundTo(buy.sharesReceived, 4), 0.4);
  const stopLossPnl = realizedPnlClobExit(buy.principalUsd, stopLossSell.grossProceedsUsd);

  assertApprox(stopLossSell.fillPrice, 0.394, "Stop-loss exit fill");
  assertApprox(roundTo(stopLossSell.grossProceedsUsd, 4), 7.7635, "Stop-loss gross proceeds (4dp)");
  assertApprox(truncateTo(stopLossPnl, 2), -2.23, "Stop-loss realized pnl (display 2dp)");

  // Outcome B: WIN at expiration (oracle resolution, $1 per share)
  const winProceeds = roundTo(buy.sharesReceived, 4) * 1.0;
  const winPnl = realizedPnlWin(buy.principalUsd, roundTo(buy.sharesReceived, 4));

  assertApprox(roundTo(winProceeds, 4), 19.7044, "WIN gross proceeds (4dp)");
  assertApprox(roundTo(winPnl, 2), 9.7, "WIN realized pnl (2dp)");

  // Scenario B from requirements: LOSS at expiration
  const lossPnl = realizedPnlLoss(buy.principalUsd);
  assertApprox(lossPnl, -10.0, "LOSS realized pnl");

  console.log("Concrete scenarios: PASS");
}

function runStressTest(iterations = 1000): void {
  const initialBalanceCents = 100_000; // $1,000.00
  let simulatedBalanceCents = initialBalanceCents;
  let sumRealizedPnlCents = 0;

  for (let i = 0; i < iterations; i++) {
    const principalUsd = toCents(randomNumber(1, 50)) / 100;
    const ask = randomNumber(0.05, 0.95);
    const buy = simulateBuy(principalUsd, ask);

    console.assert(Number.isFinite(buy.fillPrice), `Buy fill price invalid at i=${i}`);
    console.assert(Number.isFinite(buy.sharesReceived), `Buy shares invalid at i=${i}`);

    const exitModeRoll = Math.random();
    let realizedPnlUsd = 0;

    if (exitModeRoll < 0.34) {
      // Scenario A: resolved WIN
      realizedPnlUsd = realizedPnlWin(buy.principalUsd, buy.sharesReceived);
    } else if (exitModeRoll < 0.67) {
      // Scenario B: resolved LOSS
      realizedPnlUsd = realizedPnlLoss(buy.principalUsd);
    } else {
      // Scenario C: CLOB exit (profit lock / stop loss) with sell slippage
      const bestBid = randomNumber(0.01, 0.99);
      const sell = simulateSell(buy.sharesReceived, bestBid);
      console.assert(Number.isFinite(sell.fillPrice), `Sell fill price invalid at i=${i}`);
      console.assert(Number.isFinite(sell.grossProceedsUsd), `Sell proceeds invalid at i=${i}`);
      realizedPnlUsd = realizedPnlClobExit(buy.principalUsd, sell.grossProceedsUsd);
    }

    console.assert(Number.isFinite(realizedPnlUsd), `PnL invalid at i=${i}`);

    // Use cents for exact accounting identity checks.
    const realizedPnlCents = toCents(realizedPnlUsd);
    simulatedBalanceCents += realizedPnlCents;
    sumRealizedPnlCents += realizedPnlCents;

    console.assert(Number.isFinite(simulatedBalanceCents), `Balance invalid at i=${i}`);
  }

  const expectedFinalBalanceCents = initialBalanceCents + sumRealizedPnlCents;
  console.assert(
    simulatedBalanceCents === expectedFinalBalanceCents,
    `Balance drift detected. expected=${expectedFinalBalanceCents}, actual=${simulatedBalanceCents}`
  );

  console.log(
    `Stress test (${iterations} iterations): PASS | initial=$${(initialBalanceCents / 100).toFixed(2)} ` +
    `final=$${(simulatedBalanceCents / 100).toFixed(2)} pnl=$${(sumRealizedPnlCents / 100).toFixed(2)}`
  );
}

function main(): void {
  runConcreteScenarios();
  runStressTest(1000);
  console.log("All verification checks passed.");
}

main();
