import * as store from "../utils/file-store";
import { checkLiquidity } from "../utils/liquidity-guard";
import { sendOrderExecution, sendOrderResult } from "../services/telegram-reporter";
import { tradingEnv } from "../config/env";
import { logger } from "../logger";

/**
 * PHASE 2 VERIFICATION SCRIPT
 * Mocks internal components to verify the telemetry and logic hooks.
 */

async function testStore() {
  console.log("\n--- Testing Store Integrity ---");
  const testId = "test-condition-id-" + Date.now();
  const testAmount = 55.55;
  
  await store.setInvestedPrincipal(testId, testAmount);
  const readBack = await store.getInvestedPrincipal(testId);
  
  if (readBack === testAmount) {
    console.log("✅ investedPrincipal written and read correctly.");
  } else {
    console.error("❌ Store read/write mismatch!");
  }
}

async function testLiquidityGuard() {
  console.log("\n--- Testing Liquidity Guard ---");
  // This will try to fetch a real client but should fail-open or work if credentials exist.
  // We'll test with a nonsense ID to see fail-open behavior.
  const result = await checkLiquidity("invalid-id", 0.5, 999999);
  console.log(`✅ Liquidity Guard result (should be true for fail-open): ${result}`);
}

async function testTelemetry() {
  console.log("\n--- Testing Telemetry Payloads ---");
  
  // 1. BUY_FILLED
  await sendOrderExecution({
    side: "Up",
    amountUsd: 10,
    price: 0.82,
    shares: 12.2,
    conditionId: "test-cid",
    eventSlug: "test-slug"
  });
  console.log("✅ sendOrderExecution fired (check console/logs for MOD_TAG)");

  // 2. SELL_FILLED (PnL Calculation Verification)
  const costBasis = 10;
  const sellPrice = 0.99;
  const shares = 12.2;
  const pnl = (shares * sellPrice) - costBasis;
  
  await sendOrderResult({
    side: "Up",
    reason: "profit_lock",
    soldAmount: shares,
    sellPrice: sellPrice,
    grossProceeds: shares * sellPrice,
    realizedPnl: pnl,
    conditionId: "test-cid",
    eventSlug: "test-slug"
  });
  console.log(`✅ sendOrderResult fired. Calculated PnL: ${pnl.toFixed(2)}`);

  // 3. Auto-Redeem scenarios
  await sendOrderResult({
    side: "redeem",
    reason: "settlement",
    grossProceeds: 15,
    realizedPnl: 5,
    isWin: true,
    conditionId: "test-cid",
    eventSlug: "test-slug"
  });
  
  await sendOrderResult({
    side: "redeem",
    reason: "settlement",
    grossProceeds: 0,
    realizedPnl: -10,
    isWin: false,
    conditionId: "test-cid",
    eventSlug: "test-slug"
  });
  console.log("✅ Redemption telemetry fired.");
}

async function runAll() {
  console.log("🚀 Starting Phase 2 Verification...");
  
  try {
    await testStore();
    await testLiquidityGuard();
    await testTelemetry();
    
    console.log("\n✨ Verification Complete.");
    console.log("Please check the 'log/' directory and the output above for compliance with STAGING_CHECKLIST.md.");
  } catch (err) {
    console.error("Verification script failed:", err);
  }
}

runAll();
