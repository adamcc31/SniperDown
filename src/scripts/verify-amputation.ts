/**
 * VERIFICATION: Directional Amputation & Ledger Wiring
 */

import * as reporter from "../services/telegram-reporter";
import * as paperLedger from "../services/paper-ledger";
import { tradingEnv } from "../config/env";

const messages: string[] = [];
(global as any).fetch = async (url: string, init: any) => {
  if (url.includes("telegram.org")) {
    const body = JSON.parse(init.body);
    messages.push(body.text);
  }
  return { ok: true, json: async () => ({}) };
};

async function verifyLedgerWiring() {
  console.log("\n--- Ledger Wiring Verification ---");
  const initialBalance = paperLedger.getPaperBalance();
  console.log(`Initial Balance: $${initialBalance.toFixed(2)}`);

  const shares = 100;
  const exitPrice = 0.95;
  const costBasis = 80;
  const expectedPnl = (shares * exitPrice) - costBasis; // 95 - 80 = 15
  
  // Manual exit uses undefined for isWin
  paperLedger.settleMockTrade(shares, exitPrice, undefined, costBasis);
  
  const finalBalance = paperLedger.getPaperBalance();
  console.log(`Final Balance: $${finalBalance.toFixed(2)}`);
  
  if (finalBalance === initialBalance + expectedPnl) {
    console.log(`✅ Balance Updated Correcty: +$${expectedPnl.toFixed(2)}`);
  } else {
    console.error("❌ Balance Mismatch!");
  }

  // Check notification
  await reporter.sendOrderResult({
    side: "Down",
    reason: "profit_lock",
    soldAmount: shares,
    sellPrice: exitPrice,
    realizedPnl: expectedPnl,
    conditionId: "cid-test",
    eventSlug: "slug-test"
  });

  const lastMsg = messages[messages.length - 1];
  console.log("Notification:\n------------------\n" + lastMsg + "\n------------------");
  
  if (lastMsg.includes(`$${finalBalance.toFixed(2)}`)) {
    console.log("✅ Sim Balance in notification correct.");
  } else {
    console.error("❌ Sim Balance missing or incorrect in notification.");
  }
}

async function run() {
  try {
    await verifyLedgerWiring();
    console.log("\n✨ Verification Complete.");
  } catch (err) {
    console.error("Verification failed:", err);
  }
}

run();
