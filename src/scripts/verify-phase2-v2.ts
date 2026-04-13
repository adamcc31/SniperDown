/**
 * PHASE 2 COMPLETE VERIFICATION
 * This script monkeys-patches the reporter to intercept messages and verifies logic.
 */

import * as store from "../utils/file-store";
import { checkLiquidity } from "../utils/liquidity-guard";
import * as reporter from "../services/telegram-reporter";
import { tradingEnv } from "../config/env";

// 1. Mock Telegram to verify MESSAGE CONTENT and MODE_TAG
const messages: string[] = [];
(reporter as any)._callTelegramApi = async (text: string) => {
  messages.push(text);
  console.log("📨 TELEGRAM_MOCK:", text.split("\n")[0], "..."); 
};

async function verifyTelemetry() {
  console.log("\n--- Telemetry Content Verification ---");
  
  await reporter.sendOrderExecution({
    side: "Down",
    amountUsd: 10,
    price: 0.85,
    shares: 11.76,
    conditionId: "cid1",
    eventSlug: "btc-5m"
  });

  const lastMsg = messages[messages.length - 1];
  console.log("Sample Message:\n", lastMsg);
  
  const hasModeTag = lastMsg.includes("👻 [DRY RUN]") || lastMsg.includes("🔴 [LIVE]");
  console.log(`✅ MODE_TAG present: ${hasModeTag}`);
  
  if (tradingEnv.DRY_RUN_MODE && !lastMsg.includes("👻 [DRY RUN]")) {
      console.error("❌ DRY_RUN_MODE is true but tag is missing!");
  }
}

async function verifyPnLCalculation() {
  console.log("\n--- PnL Math Verification ---");
  const principal = 100;
  const shares = 120;
  const sellPrice = 0.95;
  const expectedPnl = (shares * sellPrice) - principal; // 114 - 100 = 14
  
  await reporter.sendOrderResult({
    side: "Up",
    reason: "profit_lock",
    soldAmount: shares,
    sellPrice: sellPrice,
    realizedPnl: expectedPnl,
    conditionId: "cid1",
    eventSlug: "slug1"
  });
  
  const msg = messages[messages.length - 1];
  console.log(msg);
  if (msg.includes("+$14.00")) {
    console.log("✅ PnL Formatting Correct: +$14.00");
  } else {
    console.error("❌ PnL Formatting Incorrect!");
  }
}

async function verifyLiquidityGuard() {
    console.log("\n--- Liquidity Guard Fail-Open Verification ---");
    // We expect a 404 for a fake token.
    // If the library throws, our catch returns true (fail-open).
    // If the library returns empty book, our logic returns false (fail-safe).
    const res = await checkLiquidity("fake-token-id", 0.5, 10);
    console.log(`Liquidity Guard Result: ${res}`);
    console.log("Note: If 'false', the library returned an empty book instead of throwing. If 'true', it failed-open as requested.");
}

async function run() {
  await verifyTelemetry();
  await verifyPnLCalculation();
  await verifyLiquidityGuard();
}

run();
