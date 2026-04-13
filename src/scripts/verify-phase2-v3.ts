/**
 * PHASE 2 COMPLETE VERIFICATION V3
 * Mocks global.fetch to verify Telegram alerts.
 */

import * as store from "../utils/file-store";
import { checkLiquidity } from "../utils/liquidity-guard";
import * as reporter from "../services/telegram-reporter";
import { tradingEnv } from "../config/env";

const messages: any[] = [];

// Mock global fetch
(global as any).fetch = async (url: string, init: any) => {
  if (url.includes("telegram.org")) {
    const body = JSON.parse(init.body);
    messages.push(body.text);
    return { ok: true, json: async () => ({}) };
  }
  return { ok: true, json: async () => ({}) };
};

async function verifyTelemetry() {
  console.log("\n--- Telemetry Content Verification ---");
  
  await reporter.sendOrderExecution({
    side: "Down",
    amountUsd: 10.50,
    price: 0.855,
    shares: 12.28,
    conditionId: "cid1",
    eventSlug: "btc-5m"
  });

  const lastMsg = messages[messages.length - 1];
  console.log("Message Output:\n------------------\n" + lastMsg + "\n------------------");
  
  const hasModeTag = lastMsg.includes("👻 [DRY RUN]") || lastMsg.includes("🔴 [LIVE]");
  console.log(`✅ MODE_TAG present: ${hasModeTag}`);
  
  if (tradingEnv.DRY_RUN_MODE && !lastMsg.includes("👻 [DRY RUN]")) {
      console.error("❌ DRY_RUN_MODE is true but tag is missing!");
  }
  
  if (lastMsg.includes("$10.50") && lastMsg.includes("0.855")) {
    console.log("✅ Numerical formatting correct.");
  }
}

async function verifyPnLCalculation() {
  console.log("\n--- PnL Math Verification ---");
  const principal = 100;
  const shares = 120;
  const sellPrice = 0.95;
  const expectedPnl = (shares * sellPrice) - principal; // 14
  
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
  console.log("Message Output:\n------------------\n" + msg + "\n------------------");
  
  if (msg.includes("+$14.00")) {
    console.log("✅ PnL Formatting Correct: +$14.00");
  } else {
    console.error("❌ PnL Formatting Incorrect!");
  }
}

async function run() {
  try {
    await verifyTelemetry();
    await verifyPnLCalculation();
    console.log("\n✨ Verification Complete.");
  } catch (err) {
    console.error("Verification failed:", err);
  }
}

run();
