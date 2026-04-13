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

export function sendOrderResult(status: string, reasonDetails: string = "", realizedPnl?: number) {
  let simulatedStr = tradingEnv.DRY_RUN_MODE ? " 👻 [DRY RUN]" : "";
  let pnlStr = "";
  if (realizedPnl !== undefined) {
    const sign = realizedPnl >= 0 ? "+" : "";
    pnlStr = `\nRealized PnL: *${sign}$${realizedPnl.toFixed(2)}*`;
  }

  const stats = getPaperStats();
  const statsBlock = `\n\n📊 *Daily Performance*\nDaily PnL: $${stats.dailyPnl.toFixed(2)}\nWin/Loss: ${stats.winCount}W / ${stats.lossCount}L\nWin Rate: ${stats.winRate.toFixed(1)}%`;

  _callTelegramApi(`✅ *Order Result*${simulatedStr}\nStatus: ${status}\nDetails: ${reasonDetails}${pnlStr}${statsBlock}`);
}

export function sendClaimedPrize(amountUsd: number) {
  const simulatedStr = tradingEnv.DRY_RUN_MODE ? " 👻 [DRY RUN]" : "";
  const stats = getPaperStats();
  const statsBlock = `\n\n📊 *Daily Performance*\nDaily PnL: $${stats.dailyPnl.toFixed(2)}\nWin Rate: ${stats.winRate.toFixed(1)}%`;

  _callTelegramApi(`🏆 *Prize Claimed*${simulatedStr}\nSuccessfully auto-redeemed winning tokens!\nPayout: $${amountUsd.toFixed(2)}${statsBlock}`);
}

export function sendActionAborted(reason: string, details: string) {
  _callTelegramApi(`🚫 *Action Aborted*\nReason: ${reason}\nDetails: ${details}`);
}

export function sendDryRunSummary(uptimeStr: string) {
  const stats = getPaperStats();
  _callTelegramApi(`📊 *Dry Run Summary*\nRuntime: ${uptimeStr}\nTotal Executions: ${stats.totalMockTrades}\nWins: ${stats.winCount} | Losses: ${stats.lossCount}\nDaily PnL: $${stats.dailyPnl.toFixed(2)}\nGross PnL: $${stats.grossPnl.toFixed(2)}\nWin Rate: ${stats.winRate.toFixed(1)}%`);
}

export function sendExpirationSettlement(outcome: "WIN" | "LOSS", shares: number, payout: number, conditionId: string) {
  const emoji = outcome === "WIN" ? "🏆" : "💀";
  const short = conditionId.length > 14 ? conditionId.slice(0, 10) + "…" : conditionId;
  const stats = getPaperStats();
  const statsBlock = `\n\n📊 *Daily Performance*\nDaily PnL: $${stats.dailyPnl.toFixed(2)}\nWin Rate: ${stats.winRate.toFixed(1)}%`;

  _callTelegramApi(
    `${emoji} *Market Expiration Settlement* 👻 [DRY RUN]\n` +
    `Outcome: *${outcome}*\n` +
    `Shares Held: ${shares.toFixed(2)}\n` +
    `Payout: $${payout.toFixed(2)}\n` +
    `Market: \`${short}\`` +
    statsBlock
  );
}
