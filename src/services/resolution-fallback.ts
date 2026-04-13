/**
 * Resolution Fallback Service
 * 
 * When a market expires and the WS unsubscribes to move to the next window,
 * this module handles the dangling holdings left behind.
 * 
 * Flow:
 * 1. Triggered by win-monitor when conditionId changes and old holdings exist.
 * 2. Waits 60s for Polymarket to finalize on-chain resolution.
 * 3. Queries CTF contract for winning outcome.
 * 4. Settles paper balance: WIN → shares * $1.00, LOSS → $0.00.
 * 5. Fires Telegram alert and wipes holdings.
 */

import { isMarketResolved } from "../utils/redeem";
import { getAllHoldings, clearMarketHoldings } from "../utils/holdings";
import { addPaperBalance, recordMockTrade, recordMockWin, recordMockLoss } from "./paper-ledger";
import { sendExpirationSettlement } from "./telegram-reporter";
import { logger, shortId } from "../logger";
import * as store from "../utils/file-store";

const RESOLUTION_DELAY_MS = 60_000;     // Wait 60s for Polymarket API to finalize
const MAX_RESOLUTION_RETRIES = 5;
const RETRY_INTERVAL_MS = 30_000;       // 30s between retries

/**
 * Schedule a delayed resolution check for the old market.
 * Called from WinMonitor when the conditionId changes and holdings > 0.
 */
export function scheduleResolutionFallback(
  oldConditionId: string,
  downTokenId: string
): void {
  // Snapshot current holdings at scheduling time
  const holdings = getAllHoldings();
  const marketHoldings = holdings[oldConditionId];
  if (!marketHoldings) return;

  const totalShares = Object.values(marketHoldings).reduce((sum, amt) => sum + amt, 0);
  if (totalShares <= 0) return;

  logger.info(
    `⏳ Resolution Fallback: Scheduling for ${shortId(oldConditionId)} ` +
    `(${totalShares.toFixed(2)} shares) in ${RESOLUTION_DELAY_MS / 1000}s`
  );

  setTimeout(async () => {
    try {
      await resolveExpiredMarket(oldConditionId, downTokenId);
    } catch (err) {
      logger.error(`Resolution Fallback fatal error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, RESOLUTION_DELAY_MS);
}

/**
 * Attempt to resolve an expired market with retries.
 * Determines WIN/LOSS for held DOWN tokens, settles balance, fires TG alert.
 */
async function resolveExpiredMarket(
  conditionId: string,
  _downTokenId: string
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RESOLUTION_RETRIES; attempt++) {
    // Re-check holdings — auto-redeem may have already handled it
    const currentHoldings = getAllHoldings();
    const marketHoldings = currentHoldings[conditionId];
    if (!marketHoldings) {
      logger.info(`Resolution Fallback: ${shortId(conditionId)} holdings already cleared. Skipping.`);
      return;
    }
    const totalShares = Object.values(marketHoldings).reduce((sum, amt) => sum + amt, 0);
    if (totalShares <= 0) {
      logger.info(`Resolution Fallback: ${shortId(conditionId)} shares = 0. Skipping.`);
      clearMarketHoldings(conditionId);
      return;
    }

    try {
      logger.info(
        `Resolution Fallback: Checking ${shortId(conditionId)} ` +
        `(attempt ${attempt}/${MAX_RESOLUTION_RETRIES}, ${totalShares.toFixed(2)} shares)`
      );

      const { isResolved, winningIndexSets } = await isMarketResolved(conditionId);

      if (!isResolved) {
        if (attempt < MAX_RESOLUTION_RETRIES) {
          logger.info(
            `Resolution Fallback: ${shortId(conditionId)} not yet resolved. ` +
            `Retrying in ${RETRY_INTERVAL_MS / 1000}s...`
          );
          await new Promise(r => setTimeout(r, RETRY_INTERVAL_MS));
          continue;
        }
        // Final attempt — force LOSS settlement to prevent permanently dangling holdings
        logger.warn(
          `Resolution Fallback: ${shortId(conditionId)} still unresolved after ` +
          `${MAX_RESOLUTION_RETRIES} attempts. Force-settling as LOSS.`
        );
        recordMockTrade();
        recordMockLoss();
        clearMarketHoldings(conditionId);
        await store.setPosition(conditionId, null);
        sendExpirationSettlement("LOSS", totalShares, 0, conditionId);
        return;
      }

      // DOWN token = clobTokenIds[1] = outcome slot 1 = indexSet 2
      const downWon = winningIndexSets?.includes(2) ?? false;

      if (downWon) {
        const payout = totalShares * 1.00;
        addPaperBalance(payout);
        recordMockTrade();
        recordMockWin();
        logger.ok(
          `Resolution Fallback: ${shortId(conditionId)} → DOWN WON. ` +
          `Added $${payout.toFixed(2)} (${totalShares.toFixed(2)} shares × $1.00)`
        );
        sendExpirationSettlement("WIN", totalShares, payout, conditionId);
      } else {
        // DOWN lost — no payout. Cost was already deducted at buy time.
        recordMockTrade();
        recordMockLoss();
        logger.warn(
          `Resolution Fallback: ${shortId(conditionId)} → DOWN LOST. ` +
          `${totalShares.toFixed(2)} shares worthless. No balance adjustment.`
        );
        sendExpirationSettlement("LOSS", totalShares, 0, conditionId);
      }

      clearMarketHoldings(conditionId);
      await store.setPosition(conditionId, null);
      return;

    } catch (err) {
      logger.error(
        `Resolution Fallback error (attempt ${attempt}): ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
      if (attempt < MAX_RESOLUTION_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_INTERVAL_MS));
      } else {
        // Exhaust retries — force LOSS settlement
        logger.warn(`Resolution Fallback: Exhausted retries for ${shortId(conditionId)}. Force-settling as LOSS.`);
        recordMockTrade();
        recordMockLoss();
        clearMarketHoldings(conditionId);
        await store.setPosition(conditionId, null);
        sendExpirationSettlement("LOSS", totalShares, 0, conditionId);
      }
    }
  }
}
