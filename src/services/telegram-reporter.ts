import { tradingEnv } from "../config/env";
import { logger } from "../logger";

function _callTelegramApi(text: string) {
  const token = tradingEnv.TG_BOT_TOKEN;
  const chatId = tradingEnv.TG_CHAT_ID;
  if (!token || !chatId) return;

  let finalText = text;
  if (tradingEnv.DRY_RUN_MODE) {
    const { currentBalance } = getPaperStats();
    finalText += `\n\n💰 [Sim Balance: $${currentBalance.toFixed(2)}]`;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  
  // Fire and forget (async, catch errors so it doesn't crash the loop)
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: finalText,
      parse_mode: "Markdown"
    })
  }).catch((err) => {
    logger.error("Telegram API error", err);
  });
}

export function sendStartPing() {
  const mode = tradingEnv.DRY_RUN_MODE ? "ON (Simulating)" : "OFF (Live Capital)";
  _callTelegramApi(`🟢 *Down Sniper Initialized*\nMarket: \`${tradingEnv.POLYMARKET_SLUG_PREFIX}\`\nDry Run: *${mode}*`);
}

export function sendHeartbeat() {
  _callTelegramApi(`⏱️ *Sniper Heartbeat*\nMarket: \`${tradingEnv.POLYMARKET_SLUG_PREFIX}\`\nStatus: Scanning for targets...`);
}

export function sendOrderExecution(direction: string, type: string, price: number, amountUsd: number) {
  const simulatedStr = tradingEnv.DRY_RUN_MODE ? " 👻 [DRY RUN]" : "";
  _callTelegramApi(`⚡ *Order Execution Triggered*${simulatedStr}\nType: ${type}\nDirection: ${direction}\nAmount: $${amountUsd.toFixed(2)}\nRef Price: $${price.toFixed(3)}\nMarket: \`${tradingEnv.POLYMARKET_SLUG_PREFIX}\``);
}

import { getPaperStats } from "./paper-ledger";

export function sendOrderResult(status: string, reasonDetails: string = "") {
  let simulatedStr = "";
  if (tradingEnv.DRY_RUN_MODE) {
    simulatedStr = ` 👻 [DRY RUN]`;
  }
  _callTelegramApi(`✅ *Order Result*${simulatedStr}\nStatus: ${status}\nDetails: ${reasonDetails}`);
}

export function sendClaimedPrize(amountUsd: number) {
  const simulatedStr = tradingEnv.DRY_RUN_MODE ? " 👻 [DRY RUN]" : "";
  _callTelegramApi(`🏆 *Prize Claimed*${simulatedStr}\nSuccessfully auto-redeemed winning tokens!\nPayout: $${amountUsd.toFixed(2)}`);
}

export function sendActionAborted(reason: string, details: string) {
  _callTelegramApi(`🚫 *Action Aborted*\nReason: ${reason}\nDetails: ${details}`);
}

export function sendDryRunSummary(uptimeStr: string) {
  const stats = getPaperStats();
  _callTelegramApi(`📊 *Dry Run Summary*\nRuntime: ${uptimeStr}\nTotal Executions: ${stats.totalMockTrades}\nWins: ${stats.winCount} | Losses: ${stats.lossCount}\nGross PnL: $${stats.grossPnl.toFixed(2)}`);
}
