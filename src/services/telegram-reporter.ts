import { tradingEnv } from "../config/env";
import { logger } from "../logger";
import { getPaperStats } from "./paper-ledger";

const MODE_TAG = tradingEnv.DRY_RUN_MODE ? "👻 [DRY RUN]" : "🔴 [LIVE]";

export interface OrderExecutionPayload {
  side: "Up" | "Down";
  amountUsd: number;
  price: number;
  shares: number;
  conditionId: string;
  eventSlug: string;
}

export interface OrderResultPayload {
  side: "Up" | "Down" | "redeem";
  reason: "profit_lock" | "stop_loss" | "settlement";
  soldAmount?: number;
  sellPrice?: number;
  realizedPnl: number;
  isWin?: boolean;
  conditionId: string;
  eventSlug: string;
}

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

export async function sendOrderExecution(payload: OrderExecutionPayload) {
  const { side, amountUsd, price, shares } = payload;
  await _callTelegramApi(
    `⚡ *Order Execution Triggered* ${MODE_TAG}\n` +
    `Type: Market (FAK)\n` +
    `Direction: ${side}\n` +
    `Amount: $${amountUsd.toFixed(2)}\n` +
    `Fill Price: $${price.toFixed(3)}\n` +
    `Shares Received: ${shares.toFixed(2)}\n` +
    `Market: \`${tradingEnv.POLYMARKET_SLUG_PREFIX}\``
  );
}

export async function sendOrderResult(payload: OrderResultPayload) {
  const { outcome, realizedPnl, details } = {
    outcome: payload.isWin !== undefined ? (payload.isWin ? "WIN" : "LOSS") : (payload.reason === "settlement" ? "SETTLEMENT" : payload.reason.toUpperCase()),
    realizedPnl: payload.realizedPnl,
    details: `Side: ${payload.side}, Reason: ${payload.reason}`
  };

  const emoji = realizedPnl >= 0 ? "✅" : "❌";
  await _callTelegramApi(
    `${emoji} *Order Result* ${MODE_TAG}\n` +
    `Outcome: *${outcome}*\n` +
    `Realized PnL: *${realizedPnl >= 0 ? "+" : ""}$${realizedPnl.toFixed(2)}*\n` +
    `Details: ${details}`
  );
}

export async function sendClaimedPrize(amountUsd: number) {
  await _callTelegramApi(`🏆 *Prize Claimed* ${MODE_TAG}\nSuccessfully auto-redeemed winning tokens!\nPayout: $${amountUsd.toFixed(2)}`);
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
    `${emoji} *Market Expiration Settlement* ${MODE_TAG}\n` +
    `Outcome: *${outcome}*\n` +
    `Shares Held: ${shares.toFixed(2)}\n` +
    `Payout: $${payout.toFixed(2)}\n` +
    `Market: \`${short}\``
  );
}
