import { tradingEnv } from "../config/env";
import { logger } from "../logger";

async function _callTelegramApi(text: string): Promise<void> {
  const token = tradingEnv.TG_BOT_TOKEN;
  const chatId = tradingEnv.TG_CHAT_ID;
  if (!token || !chatId) return;

  let finalText = text;
  if (tradingEnv.DRY_RUN_MODE) {
    const { currentBalance } = getPaperStats();
    finalText += `\n\n💰 [Sim Balance: $${currentBalance.toFixed(2)}]`;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: finalText,
        parse_mode: "Markdown"
      })
    });
  } catch (err) {
    logger.error("Telegram API error", err);
  }
}

export async function sendStartPing() {
  const mode = tradingEnv.DRY_RUN_MODE ? "ON (Simulating)" : "OFF (Live Capital)";
  await _callTelegramApi(`🟢 *Down Sniper Initialized*\nMarket: \`${tradingEnv.POLYMARKET_SLUG_PREFIX}\`\nDry Run: *${mode}*`);
}

export async function sendHeartbeat() {
  await _callTelegramApi(`⏱️ *Sniper Heartbeat*\nMarket: \`${tradingEnv.POLYMARKET_SLUG_PREFIX}\`\nStatus: Scanning for targets...`);
}

export async function sendOrderExecution(direction: string, type: string, price: number, amountUsd: number) {
  const simulatedStr = tradingEnv.DRY_RUN_MODE ? " 👻 [DRY RUN]" : "";
  await _callTelegramApi(`⚡ *Order Execution Triggered*${simulatedStr}\nType: ${type}\nDirection: ${direction}\nAmount: $${amountUsd.toFixed(2)}\nRef Price: $${price.toFixed(3)}\nMarket: \`${tradingEnv.POLYMARKET_SLUG_PREFIX}\``);
}

import { getPaperStats } from "./paper-ledger";

export async function sendOrderResult(status: string, reasonDetails: string = "") {
  let simulatedStr = "";
  if (tradingEnv.DRY_RUN_MODE) {
    simulatedStr = ` 👻 [DRY RUN]`;
  }
  await _callTelegramApi(`✅ *Order Result*${simulatedStr}\nStatus: ${status}\nDetails: ${reasonDetails}`);
}

export async function sendClaimedPrize(amountUsd: number) {
  const simulatedStr = tradingEnv.DRY_RUN_MODE ? " 👻 [DRY RUN]" : "";
  await _callTelegramApi(`🏆 *Prize Claimed*${simulatedStr}\nSuccessfully auto-redeemed winning tokens!\nPayout: $${amountUsd.toFixed(2)}`);
}

export async function sendActionAborted(reason: string, details: string) {
  await _callTelegramApi(`🚫 *Action Aborted*\nReason: ${reason}\nDetails: ${details}`);
}

export async function sendDryRunSummary(uptimeStr: string) {
  const stats = getPaperStats();
  await _callTelegramApi(`📊 *Dry Run Summary*\nRuntime: ${uptimeStr}\nTotal Closed: ${stats.winCount + stats.lossCount}\nWins: ${stats.winCount} | Losses: ${stats.lossCount}\nWin Rate: ${stats.winRate.toFixed(1)}%\nGross PnL: $${stats.grossPnl.toFixed(2)}`);
}

export async function sendExpirationSettlement(outcome: "WIN" | "LOSS", shares: number, payout: number, conditionId: string) {
  const emoji = outcome === "WIN" ? "🏆" : "💀";
  const short = conditionId.length > 14 ? conditionId.slice(0, 10) + "…" : conditionId;
  await _callTelegramApi(
    `${emoji} *Market Expiration Settlement* 👻 [DRY RUN]\n` +
    `Outcome: *${outcome}*\n` +
    `Shares Held: ${shares.toFixed(2)}\n` +
    `Payout: $${payout.toFixed(2)}\n` +
    `Market: \`${short}\``
  );
}
