import { logger } from "../logger";
import { tradingEnv } from "../config/env";
import { sendActionAborted } from "./telegram-reporter";

let consecutiveLosses = 0;
let botPausedUntil = 0;

/**
 * Tracks win/loss streaks and manages market regime pauses.
 */
export const regimeFilter = {
  recordWin() {
    consecutiveLosses = 0;
    logger.info("Regime Filter: Win recorded. Streak reset.");
  },

  recordLoss() {
    consecutiveLosses++;
    logger.warn(`Regime Filter: Loss recorded. Consecutive Losses: ${consecutiveLosses}`);
    
    if (consecutiveLosses >= 3) {
      const pauseDurationMs = 60 * 60 * 1000; // 1 hour
      botPausedUntil = Date.now() + pauseDurationMs;
      logger.error("Regime Filter: 3 consecutive losses hit. TRIGGERING 1-HOUR COOLDOWN.");
      sendActionAborted("Consecutive Loss Cool-down", "3 consecutive Stop Losses hit. Market regime appears too volatile. Pausing for 1 hour.");
    }
  },

  isPaused(): boolean {
    if (botPausedUntil > Date.now()) {
      return true;
    }
    return false;
  },

  getCooldownRemainingMinutes(): number {
    if (!this.isPaused()) return 0;
    return Math.ceil((botPausedUntil - Date.now()) / (60 * 1000));
  },

  /**
   * Checks if the daily drawdown limit has been breached.
   * If breached, logs critical error and returns true.
   */
  checkCircuitBreaker(currentBalance: number, dailyStartingBalance: number): boolean {
    const drawdownPercent = (dailyStartingBalance - currentBalance) / dailyStartingBalance;
    const limit = tradingEnv.MAX_DAILY_DRAWDOWN_PERCENT;

    if (drawdownPercent >= limit) {
      logger.error(`ALGORITHMIC CIRCUIT BREAKER: Daily Drawdown (${(drawdownPercent * 100).toFixed(2)}%) exceeds limit (${(limit * 100).toFixed(2)}%).`);
      sendActionAborted("Daily Circuit Breaker", `Daily Drawdown limit of ${(limit * 100).toFixed(0)}% breached ($${(dailyStartingBalance - currentBalance).toFixed(2)} loss). SHUTTING DOWN.`);
      return true;
    }
    return false;
  }
};
