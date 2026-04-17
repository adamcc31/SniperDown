import { tradingEnv } from "../config/env";
import { logger } from "../logger";
import { getPaperStats } from "./paper-ledger";

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
  grossProceeds: number;
  realizedPnl: number;
  isWin?: boolean;
  conditionId: string;
  eventSlug: string;
}

async function _callTelegramApi(text: string): Promise<void> {
  const token = tradingEnv.TG_BOT_TOKEN;
  const chatId = tradingEnv.TG_CHAT_ID;
  if (!token || !chatId) return;

  const finalText = text;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: finalText
      })
    });
  } catch (err) {
    logger.error("Telegram API error", err);
  }
}

export async function sendTelegram(message: string): Promise<void> {
  await _callTelegramApi(message);
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
  const modeSuffix = tradingEnv.DRY_RUN_MODE ? " 👻 DRY RUN" : "";
  const marketRef = payload.eventSlug || payload.conditionId;
  const simBalanceLine = tradingEnv.DRY_RUN_MODE
    ? `\n\n💰 Sim Balance: $${getPaperStats().currentBalance.toFixed(2)}`
    : "";
  await _callTelegramApi(
    `⚡ Order Execution Triggered${modeSuffix}\n` +
    `Type: BUY Market (FAK)\n` +
    `Direction: ${side}\n` +
    `Amount: $${amountUsd.toFixed(2)}\n` +
    `Fill Price: $${price.toFixed(3)}\n` +
    `Shares Received: ${shares.toFixed(4)}\n` +
    `Market: ${marketRef}` +
    simBalanceLine
  );
}

export async function sendOrderResult(payload: OrderResultPayload) {
  const realizedPnl = payload.realizedPnl;
  const outcome = payload.isWin !== undefined
    ? (payload.isWin ? "WIN" : "LOSS")
    : (realizedPnl >= 0 ? "WIN" : "LOSS");
  const emoji = outcome === "WIN" ? "✅" : "❌";
  const modeSuffix = tradingEnv.DRY_RUN_MODE ? " 👻 DRY RUN" : "";
  const pnlText = `${realizedPnl >= 0 ? "+" : "-"}$${Math.abs(realizedPnl).toFixed(2)}`;
  const simBalanceLine = tradingEnv.DRY_RUN_MODE
    ? `\n\n💰 Sim Balance: $${getPaperStats().currentBalance.toFixed(2)}`
    : "";

  await _callTelegramApi(
    `${emoji} Order Result${modeSuffix}\n` +
    `Outcome: ${outcome}\n` +
    `Gross Payout: $${payload.grossProceeds.toFixed(4)}\n` +
    `Net PnL: ${pnlText}\n` +
    `Details: Side: ${payload.side}, Reason: ${payload.reason}` +
    simBalanceLine
  );
}

export async function sendClaimedPrize(amountUsd: number) {
  const modeSuffix = tradingEnv.DRY_RUN_MODE ? " 👻 DRY RUN" : "";
  await _callTelegramApi(`🏆 Prize Claimed${modeSuffix}\nSuccessfully auto-redeemed winning tokens!\nPayout: $${amountUsd.toFixed(2)}`);
}

export async function sendActionAborted(reason: string, details: string) {
  await _callTelegramApi(`🚫 *Action Aborted*\nReason: ${reason}\nDetails: ${details}`);
}

export async function sendDryRunSummary(uptimeStr: string) {
  const stats = getPaperStats();
  await _callTelegramApi(
    `📊 Dry Run Summary\n` +
    `Runtime: ${uptimeStr}\n` +
    `Total Closed: ${stats.winCount + stats.lossCount}\n` +
    `Gross PnL: $${stats.grossPnl.toFixed(2)}\n` +
    `Sim Balance: $${stats.currentBalance.toFixed(2)}`
  );
}

export async function sendExpirationSettlement(outcome: "WIN" | "LOSS", shares: number, payout: number, conditionId: string) {
  const emoji = outcome === "WIN" ? "🏆" : "💀";
  const modeSuffix = tradingEnv.DRY_RUN_MODE ? " 👻 DRY RUN" : "";
  const short = conditionId.length > 14 ? conditionId.slice(0, 10) + "…" : conditionId;
  await _callTelegramApi(
    `${emoji} Market Expiration Settlement${modeSuffix}\n` +
    `Outcome: ${outcome}\n` +
    `Shares Held: ${shares.toFixed(2)}\n` +
    `Payout: $${payout.toFixed(2)}\n` +
    `Market: ${short}`
  );
}
