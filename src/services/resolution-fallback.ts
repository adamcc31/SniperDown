/**
 * Resolution Fallback Service
 * 
 * Background settlement for expired markets.
 * Polls until WIN/LOSS is confirmed by oracle, then settles balance.
 */

import { isMarketResolved } from "../utils/redeem";
import { clearMarketHoldings } from "../utils/holdings";
import { settleMockTrade } from "./paper-ledger";
import { sendOrderResult } from "./telegram-reporter";
import { logger, shortId } from "../logger";
import * as store from "../utils/file-store";

const INITIAL_POLL_DELAY_MS = 30_000;    
const MAX_POLL_INTERVAL_MS = 600_000;   // Max 10 mins between polls

/**
 * Detached background settlement.
 * Polls the Polymarket API until a definitive result is returned.
 */
export async function forceInstantSettlement(
  conditionId: string,
  shares: number,
  principalToRedeem: number
): Promise<void> {
  if (shares <= 0 || principalToRedeem <= 0) {
    logger.skip(`Background Settlement skipped for ${shortId(conditionId)}: No shares/principal.`);
    return;
  }

  logger.info(`🔄 Background Settlement Started: ${shortId(conditionId)} (${shares.toFixed(2)} shares, principal: $${principalToRedeem.toFixed(2)})`);

  let pollDelay = INITIAL_POLL_DELAY_MS;
  let attempt = 1;

  while (true) {
    try {
      const { isResolved, winningIndexSets } = await isMarketResolved(conditionId);

      if (isResolved) {
        // DOWN token = clobTokenIds[1] = outcome slot 1 = indexSet 2
        const downWon = winningIndexSets?.includes(2) ?? false;
        const outcome = downWon ? "WIN" : "LOSS";
        
        const { pnl } = settleMockTrade(shares, 0, downWon, principalToRedeem);
        
        logger.ok(
          `Resolution Confirmed: ${shortId(conditionId)} → ${outcome}. ` +
          `Principal: $${principalToRedeem.toFixed(2)}, PnL: $${pnl.toFixed(2)}`
        );

        // Final Telegram Alert
        await sendOrderResult(
          `EXPIRATION_${outcome}`,
          pnl,
          `Market ${shortId(conditionId)} settled via Oracle.\noutcome=${outcome}\nshares=${shares.toFixed(2)}`
        );
        
        // Final State Cleanup
        clearMarketHoldings(conditionId);
        await store.setPosition(conditionId, null);
        return;
      }

      // Not resolved yet, wait and retry with exponential backoff
      logger.info(`Settlement pending for ${shortId(conditionId)} (attempt ${attempt}). Retrying in ${pollDelay/1000}s...`);
      await new Promise(r => setTimeout(r, pollDelay));
      
      attempt++;
      pollDelay = Math.min(pollDelay * 1.5, MAX_POLL_INTERVAL_MS);

    } catch (err) {
      logger.error(`Settlement Polling Error for ${shortId(conditionId)}: ${err instanceof Error ? err.message : String(err)}`);
      await new Promise(r => setTimeout(r, pollDelay));
    }
  }
}

/** Legacy hook maintained for basic export mapping if needed. */
export function scheduleResolutionFallback(oldConditionId: string, dt: string): void {
  // Now handled directly by WinMonitor calling forceInstantSettlement
}
