/**
 * Win monitor: resolve current/next market by slug (auto-switch when market ends),
 * monitor prices via WebSocket, buy when winning token > X, profit lock at 0.99, stop loss at Y.
 * Uses JSON file store (no Redis/MongoDB).
 */

import { PolymarketClient } from "../clients/polymarket";
import { buyToken, sellToken } from "./win-trading";
import { getWindowSecondsFromSlug } from "../config/env";
import { tradingEnv } from "../config/env";
import { logger } from "../logger";
import { getHoldings, getAllHoldings } from "../utils/holdings";
import * as store from "../utils/file-store";
import type { WinPosition, MarketInfo } from "../types";
import type { RealtimePriceService } from "./realtime-price-service";
import { checkLiquidity } from "../utils/liquidity-guard";
import { forceInstantSettlement } from "./resolution-fallback";
import { sendOrderResult } from "./telegram-reporter";
import * as paperLedger from "../services/paper-ledger";
import { simulateSellFillPrice, simulateGrossProceeds, realizedPnlFromClobExit } from "./sim-math";

function getSlugPrefix(): string {
  let raw = tradingEnv.POLYMARKET_SLUG_PREFIX || "";
  if (raw.includes("-")) {
    const parts = raw.split("-");
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last)) {
      return parts.slice(0, -1).join("-");
    }
  }
  return raw;
}

export class WinMonitor {
  private lastConditionId: string | null = null;
  private isExecutingTrade = false;
  private isCheckingExit = false;
  private isExecutingSell = false;
  private lastExitAttemptTime = 0;
  private exitCooldownMs = 2000;
  private readonly BASE_COOLDOWN_MS = 2000;
  private readonly MAX_STOPLOSS_COOLDOWN_MS = 30000;
  private consecutiveSellFailures = 0;

  constructor(
    private polymarket: PolymarketClient,
    private realtimePriceService: RealtimePriceService | null
  ) {}

  async processCycle(): Promise<void> {
    const enabled = await store.getEnabled();
    if (!enabled) return;

    const slugPrefix = getSlugPrefix();
    if (!slugPrefix?.trim()) {
      logger.skip("Win: POLYMARKET_SLUG_PREFIX not set (e.g. btc-updown-5m, eth-updown-15m, xrp-updown-1h)");
      return;
    }

    const windowSeconds = getWindowSecondsFromSlug(slugPrefix);
    const resolved = await this.polymarket.getCurrentOrNextEvent(slugPrefix, windowSeconds);
    if (!resolved) return;

    const { event, slug } = resolved;
    const marketInfo = this.polymarket.getMarketInfoFromEvent(event);
    if (!marketInfo?.upTokenId || !marketInfo?.downTokenId) {
      logger.skip("Win: no token IDs for market");
      return;
    }

    await store.setEventSlug(marketInfo.conditionId, marketInfo.eventSlug);

    if (this.lastConditionId !== marketInfo.conditionId) {
      const oldConditionId = this.lastConditionId;
      if (oldConditionId) {
        const oldTokenHoldings = getAllHoldings()[oldConditionId] ?? {};
        const oldShares = Object.values(oldTokenHoldings).reduce((sum, val) => sum + val, 0);
        const oldPrincipal = await store.getInvestedPrincipal(oldConditionId) ?? tradingEnv.BUY_AMOUNT_USD;

        if (oldShares > 0.01) {
          forceInstantSettlement(oldConditionId, oldShares, oldPrincipal)
            .catch(err => logger.error("[Settlement] Background error", err));
        }
      }
      this.lastConditionId = marketInfo.conditionId;
      this.realtimePriceService?.subscribe(
        marketInfo.conditionId,
        marketInfo.upTokenId,
        marketInfo.downTokenId
      );
    }

    let upPrice: number;
    let downPrice: number;

    if (this.realtimePriceService) {
      const upP = this.realtimePriceService.getPrice(marketInfo.upTokenId);
      const downP = this.realtimePriceService.getPrice(marketInfo.downTokenId);
      upPrice = upP ?? 0;
      downPrice = downP ?? 0;
      if (upPrice === 0 || downPrice === 0) {
        const cached = this.realtimePriceService.getCachedPrices();
        if (cached) {
          upPrice = upPrice || cached.upPrice || 0.5;
          downPrice = downPrice || cached.downPrice || 0.5;
        }
      }
    } else {
      const [upBook, downBook] = await Promise.all([
        this.polymarket.getOrderBook(marketInfo.upTokenId),
        this.polymarket.getOrderBook(marketInfo.downTokenId),
      ]);
      upPrice = upBook?.asks?.length ? parseFloat(upBook.asks[0].price) : 0.5;
      downPrice = downBook?.asks?.length ? parseFloat(downBook.asks[0].price) : 0.5;
    }

    const triggerPrice = tradingEnv.BUY_TRIGGER_PRICE;
    const maxBuyPrice = tradingEnv.MAX_BUY_PRICE;
    const stopLossPrice = tradingEnv.STOP_LOSS_PRICE;
    const profitLockPrice = tradingEnv.PROFIT_LOCK_PRICE;
    const buyAmountUsd = tradingEnv.BUY_AMOUNT_USD;

    let position = await store.getPosition(marketInfo.conditionId);
    const upShares = getHoldings(marketInfo.conditionId, marketInfo.upTokenId!);
    const downShares = getHoldings(marketInfo.conditionId, marketInfo.downTokenId!);
    const alreadyBoughtInMarket = await store.hasBoughtInMarket(marketInfo.conditionId);
    const hasPositionOrHoldings = position !== null || upShares > 0.01 || downShares > 0.01;
    const mayBuy = !alreadyBoughtInMarket && !hasPositionOrHoldings;

    if (mayBuy) {
      if (this.isExecutingTrade) {
        logger.skip(`Win: Trade already in flight (locked). Skipping buy evaluation for ${marketInfo.conditionId}`);
        return;
      }

      const currentTime = Math.floor(Date.now() / 1000);
      const ttrSeconds = Number(marketInfo.endTime) - currentTime;
      logger.info(
        `Win: TTR countdown ${ttrSeconds}s | Down ${downPrice.toFixed(3)} | Entry band [${triggerPrice}, ${maxBuyPrice}] | Golden Window [${tradingEnv.MIN_TTR_SECONDS}, ${tradingEnv.MAX_TTR_SECONDS}]`
      );

      if (ttrSeconds > tradingEnv.MAX_TTR_SECONDS || ttrSeconds < tradingEnv.MIN_TTR_SECONDS) {
        logger.skip(
          `Win: Trade aborted - TTR ${ttrSeconds}s outside Golden Window [${tradingEnv.MIN_TTR_SECONDS}, ${tradingEnv.MAX_TTR_SECONDS}]`
        );
        return;
      }

      if (downPrice >= triggerPrice && downPrice > 0 && downPrice <= maxBuyPrice) {
        logger.info(`Win: Down price ${downPrice.toFixed(3)}, TTR: ${ttrSeconds}s (Golden Window), buying Down`);
        
        const downLiqOk = await checkLiquidity(
          marketInfo.downTokenId!,
          tradingEnv.MAX_BUY_PRICE,
          tradingEnv.BUY_AMOUNT_USD
        );
        if (!downLiqOk) {
          logger.skip(`[LiquidityGuard] Insufficient volume for Down entry. Skipping cycle.`);
          return;
        }

        this.isExecutingTrade = true;
        try {
          const ok = await buyToken(
            marketInfo.downTokenId!,
            "Down",
            buyAmountUsd,
            marketInfo
          );
          if (ok) {
            await store.markBoughtInMarket(marketInfo.conditionId);
            const shares = getHoldings(marketInfo.conditionId, marketInfo.downTokenId!);
            position = {
              conditionId: marketInfo.conditionId,
              side: "Down",
              tokenId: marketInfo.downTokenId!,
              buyPrice: downPrice,
              shares,
              boughtAt: Math.floor(Date.now() / 1000),
            };
            await store.setPosition(marketInfo.conditionId, position);
          }
        } catch (err) {
          logger.error(`Win: Buy execution failed for ${marketInfo.conditionId}`, err);
        } finally {
          this.isExecutingTrade = false;
        }
      } else {
        logger.skip(
          `Win: Trade aborted - Down ${downPrice.toFixed(3)} not in entry band [${triggerPrice}, ${maxBuyPrice}] at TTR ${ttrSeconds}s`
        );
      }
    }

    if (!position) {
      if (downShares > 0.01) {
        position = {
          conditionId: marketInfo.conditionId,
          side: "Down",
          tokenId: marketInfo.downTokenId!,
          buyPrice: 0,
          shares: downShares,
          boughtAt: 0,
        };
        await store.setPosition(marketInfo.conditionId, position);
      }
    }

    if (position) {
      const currentPrice = position.side === "Up" ? upPrice : downPrice;
      const shares = getHoldings(marketInfo.conditionId, position.tokenId);
      if (shares <= 0) {
        await store.setPosition(marketInfo.conditionId, null);
      } else {
        const getBestBid = (tid: string) => this.realtimePriceService?.getBestBid(tid) ?? null;
        // Use best bid for exit evaluation — this is the price we'll actually receive.
        // Clamp to 0.99 to prevent the $1.00 impossibility from triggering phantom exits.
        const bidForExit = this.realtimePriceService?.getBestBid(position.tokenId) ?? currentPrice;
        const evalPrice = Math.min(bidForExit, 0.99);

        if (evalPrice >= profitLockPrice || evalPrice <= stopLossPrice) {
          // Hard sell lock — prevents dual-path collision with onPriceUpdate
          if (this.isExecutingSell) return;
          const now = Date.now();
          if (now - this.lastExitAttemptTime < this.exitCooldownMs) {
            return;
          }
          const reason = evalPrice >= profitLockPrice ? "profit_lock" : "stop_loss";
          
          const storedPrincipal = await store.getInvestedPrincipal(
            marketInfo.conditionId
          );
          const costBasis = storedPrincipal ?? ((position.buyPrice * shares) || tradingEnv.BUY_AMOUNT_USD);

          logger.info(`Win: ${reason} @ bid ${evalPrice.toFixed(3)} (ask ${currentPrice.toFixed(3)}), selling ${position.side} [attempt #${this.consecutiveSellFailures}]`);
          this.isExecutingSell = true;
          try {
            this.lastExitAttemptTime = Date.now();
            const ok = await sellToken(
              position.tokenId,
              shares,
              marketInfo.conditionId,
              marketInfo.eventSlug,
              position.side,
              reason,
              getBestBid,
              this.consecutiveSellFailures
            );
            if (ok) {
              // Reset cooldown state on success
              this.consecutiveSellFailures = 0;
              this.exitCooldownMs = this.BASE_COOLDOWN_MS;

              const bestBid = getBestBid(position.tokenId) ?? currentPrice;
              const simulatedExitPrice = tradingEnv.DRY_RUN_MODE
                ? simulateSellFillPrice(bestBid)
                : bestBid;
              const grossProceeds = simulateGrossProceeds(shares, simulatedExitPrice);
              const realizedPnl = realizedPnlFromClobExit(grossProceeds, costBasis);

              // 1. Update the Paper Ledger if in Dry Run
              if (tradingEnv.DRY_RUN_MODE) {
                if (paperLedger.adjustSimBalance) {
                  paperLedger.adjustSimBalance(grossProceeds);
                } else {
                  logger.warn("paperLedger.adjustSimBalance not implemented, sim balance will not update.");
                }
              }

              // 2. Await Telegram Alert
              await sendOrderResult({
                side: position.side,
                reason: reason,
                soldAmount: shares,
                sellPrice: simulatedExitPrice,
                grossProceeds,
                realizedPnl: realizedPnl,
                isWin: realizedPnl >= 0,
                conditionId: marketInfo.conditionId,
                eventSlug: marketInfo.eventSlug,
              });

              // 3. Clear the position
              await store.setPosition(marketInfo.conditionId, null);
            } else {
              // BIMODAL COOLDOWN: Hammer for profit_lock, backoff for stop_loss
              this.consecutiveSellFailures++;
              if (reason === "profit_lock") {
                // THE HAMMER — keep interval short to aggressively retry
                this.exitCooldownMs = this.BASE_COOLDOWN_MS;
                logger.warn(`[Hammer] profit_lock attempt #${this.consecutiveSellFailures} failed. Retrying in ${this.exitCooldownMs}ms.`);
              } else {
                // STOP LOSS — exponential backoff to avoid spamming illiquid markets
                this.exitCooldownMs = Math.min(
                  this.BASE_COOLDOWN_MS * Math.pow(2, this.consecutiveSellFailures),
                  this.MAX_STOPLOSS_COOLDOWN_MS
                );
                logger.warn(`[StopLoss] attempt #${this.consecutiveSellFailures} failed. Backoff cooldown: ${this.exitCooldownMs}ms.`);
              }
            }
          } finally {
            this.isExecutingSell = false;
          }
        } else {
          await store.setPosition(marketInfo.conditionId, { ...position, shares: getHoldings(marketInfo.conditionId, position.tokenId) });
        }
      }
    }

    await store.setWinState({
      upPrice,
      downPrice,
      upTokenId: marketInfo.upTokenId,
      downTokenId: marketInfo.downTokenId,
      conditionId: marketInfo.conditionId,
      position: position ?? undefined,
      currentSlug: slug,
      slugPrefix,
      marketStartTime: marketInfo.startTime,
      marketEndTime: marketInfo.endTime,
    });
  }

  async onPriceUpdate(upPrice: number, downPrice: number): Promise<void> {
    if (this.isCheckingExit) return;
    this.isCheckingExit = true;
    try {
      const conditionId = this.lastConditionId;
      if (!conditionId) return;

      const position = await store.getPosition(conditionId);
      if (!position) return;

      const currentPrice = position.side === "Up" ? upPrice : downPrice;
      const shares = getHoldings(conditionId, position.tokenId);
      if (shares <= 0) return;

      const profitLockPrice = tradingEnv.PROFIT_LOCK_PRICE;
      const stopLossPrice = tradingEnv.STOP_LOSS_PRICE;

      // Use best bid for exit evaluation — clamp to 0.99 (the $1.00 impossibility fix)
      const bidForExit = this.realtimePriceService?.getBestBid(position.tokenId) ?? currentPrice;
      const evalPrice = Math.min(bidForExit, 0.99);

      if (evalPrice >= profitLockPrice || evalPrice <= stopLossPrice) {
        // Hard sell lock — prevents dual-path collision with processCycle
        if (this.isExecutingSell) return;
        const now = Date.now();
        if (now - this.lastExitAttemptTime < this.exitCooldownMs) {
          return;
        }
        const reason = evalPrice >= profitLockPrice ? "profit_lock" : "stop_loss";
        
        // Guard: avoid double-sell
        const latestPosition = await store.getPosition(conditionId);
        if (!latestPosition) return;

        logger.info(`[onPriceUpdate] ${reason} triggered @ bid ${evalPrice.toFixed(3)} (ask ${currentPrice.toFixed(3)}, position: ${position.side}) [attempt #${this.consecutiveSellFailures}]`);
        
        const storedPrincipal = await store.getInvestedPrincipal(conditionId);
        const costBasis = storedPrincipal ?? ((position.buyPrice * shares) || tradingEnv.BUY_AMOUNT_USD);
        
        const getBestBid = (tid: string) => this.realtimePriceService?.getBestBid(tid) ?? null;
        
        const eventSlug = await store.getEventSlug(conditionId) ?? "";

        this.isExecutingSell = true;
        try {
          this.lastExitAttemptTime = Date.now();
          const ok = await sellToken(
            position.tokenId,
            shares,
            conditionId,
            eventSlug,
            position.side,
            reason,
            getBestBid,
            this.consecutiveSellFailures
          );

          if (ok) {
            // Reset cooldown state on success
            this.consecutiveSellFailures = 0;
            this.exitCooldownMs = this.BASE_COOLDOWN_MS;

            const bestBid = getBestBid(position.tokenId) ?? currentPrice;
            const simulatedExitPrice = tradingEnv.DRY_RUN_MODE
              ? simulateSellFillPrice(bestBid)
              : bestBid;
            const grossProceeds = simulateGrossProceeds(shares, simulatedExitPrice);
            const realizedPnl = realizedPnlFromClobExit(grossProceeds, costBasis);

            if (tradingEnv.DRY_RUN_MODE && paperLedger.adjustSimBalance) {
              paperLedger.adjustSimBalance(grossProceeds);
            }

            await sendOrderResult({
              side: position.side,
              reason,
              soldAmount: shares,
              sellPrice: simulatedExitPrice,
              grossProceeds,
              realizedPnl,
              isWin: realizedPnl >= 0,
              conditionId,
              eventSlug,
            });

            await store.setPosition(conditionId, null);
          } else {
            // BIMODAL COOLDOWN: Hammer for profit_lock, backoff for stop_loss
            this.consecutiveSellFailures++;
            if (reason === "profit_lock") {
              this.exitCooldownMs = this.BASE_COOLDOWN_MS;
              logger.warn(`[Hammer] profit_lock attempt #${this.consecutiveSellFailures} failed. Retrying in ${this.exitCooldownMs}ms.`);
            } else {
              this.exitCooldownMs = Math.min(
                this.BASE_COOLDOWN_MS * Math.pow(2, this.consecutiveSellFailures),
                this.MAX_STOPLOSS_COOLDOWN_MS
              );
              logger.warn(`[StopLoss] attempt #${this.consecutiveSellFailures} failed. Backoff cooldown: ${this.exitCooldownMs}ms.`);
            }
          }
        } finally {
          this.isExecutingSell = false;
        }
      }
    } finally {
      this.isCheckingExit = false;
    }
  }
}
