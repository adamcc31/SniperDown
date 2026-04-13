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
      if (downPrice >= triggerPrice && downPrice > 0 && downPrice <= maxBuyPrice) {
        logger.info(`Win: Down price ${downPrice.toFixed(3)} in [${triggerPrice}, ${maxBuyPrice}], buying Down (once per market)`);
        
        const downLiqOk = await checkLiquidity(
          marketInfo.downTokenId!,
          tradingEnv.MAX_BUY_PRICE,
          tradingEnv.BUY_AMOUNT_USD
        );
        if (!downLiqOk) {
          logger.skip(`[LiquidityGuard] Insufficient volume for Down entry. Skipping cycle.`);
          return;
        }

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
        if (currentPrice >= profitLockPrice || currentPrice <= stopLossPrice) {
          const reason = currentPrice >= profitLockPrice ? "profit_lock" : "stop_loss";
          
          const storedPrincipal = await store.getInvestedPrincipal(
            marketInfo.conditionId
          );
          const costBasis = storedPrincipal ?? ((position.buyPrice * shares) || tradingEnv.BUY_AMOUNT_USD);

          logger.info(`Win: ${reason} ${currentPrice.toFixed(3)}, selling ${position.side}`);
          const ok = await sellToken(
            position.tokenId,
            shares,
            marketInfo.conditionId,
            marketInfo.eventSlug,
            position.side,
            reason,
            getBestBid
          );
          if (ok) {
            const realizedPnl = shares * currentPrice - costBasis;

            await sendOrderResult({
              side: position.side,
              reason,
              soldAmount: shares,
              sellPrice: currentPrice,
              realizedPnl,
              conditionId: marketInfo.conditionId,
              eventSlug: marketInfo.eventSlug,
            });
            await store.setPosition(marketInfo.conditionId, null);
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
}
