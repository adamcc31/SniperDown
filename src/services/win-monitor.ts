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
import { getHoldings } from "../utils/holdings";
import * as store from "../utils/file-store";
import type { WinPosition, MarketInfo } from "../types";
import type { RealtimePriceService } from "./realtime-price-service";
import { sendActionAborted } from "./telegram-reporter";
import { getClobClient } from "../providers/clobclient";

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
  private lastEvalPrintAt: number = 0;

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
    const downShares = getHoldings(marketInfo.conditionId, marketInfo.downTokenId!);
    const alreadyBoughtInMarket = await store.hasBoughtInMarket(marketInfo.conditionId);
    const hasPositionOrHoldings = position !== null || downShares > 0;
    const mayBuy = !alreadyBoughtInMarket && !hasPositionOrHoldings;

    const now = Date.now();
    if (now - this.lastEvalPrintAt >= 4000) {
      this.lastEvalPrintAt = now;
      let actionTxt = "Waiting...";
      if (mayBuy && downPrice >= triggerPrice && downPrice <= maxBuyPrice) {
        actionTxt = "EXECUTING MOCK BUY!";
      } else if (!mayBuy) {
        actionTxt = "Position Active // Locked";
      }
      logger.info(`[EVAL] DOWN Price: ${downPrice.toFixed(3)} | Target: ${triggerPrice}-${maxBuyPrice} | Action: ${actionTxt}`);
    }

    if (mayBuy) {
      if (downPrice >= triggerPrice && downPrice > 0 && downPrice <= maxBuyPrice) {
        logger.info(`Win: Down price ${downPrice.toFixed(3)} in [${triggerPrice}, ${maxBuyPrice}], buying Down (once per market)`);
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
      if (downShares > 0) {
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

    if (position && position.side === "Down") {
      const currentPrice = downPrice;
      const shares = getHoldings(marketInfo.conditionId, position.tokenId);
      if (shares <= 0) {
        await store.setPosition(marketInfo.conditionId, null);
        return; // Guard Fix: State wipe verified, abort logic immediately to prevent infinite evaluation sweeps
      } else {
        const getBestBid = (tid: string) => this.realtimePriceService?.getBestBid(tid) ?? null;
        if (currentPrice >= profitLockPrice) {
          logger.info(`Win: profit lock ${currentPrice.toFixed(3)} >= ${profitLockPrice}, checking live orderbook...`);
          
          try {
            const clob = await getClobClient();
            const priceResp = await clob.getPrice(position.tokenId, "SELL");
            let liveBestBid = 0;
            if (typeof priceResp === "number" && !Number.isNaN(priceResp)) liveBestBid = priceResp;
            else if (priceResp && typeof priceResp === "object") {
              const o = priceResp as Record<string, unknown>;
              const p = o.mid ?? o.price ?? o.SELL ?? o.bestBid;
              if (typeof p === "number" && !Number.isNaN(p)) liveBestBid = p;
            }

            if (liveBestBid > 0 && liveBestBid < 0.98) {
              logger.warn(`Slippage Guard: Live best bid is ${liveBestBid.toFixed(3)}. Aborting profit lock to protect EV.`);
              sendActionAborted("Slippage Guard (Profit Lock)", `Desired Exit: ${profitLockPrice.toFixed(2)}, Live Bid: ${liveBestBid.toFixed(3)}.\nRetaining position for resolution.`);
              return; // Abort cycle step for this position
            }
          } catch(err) {
            logger.warn("Failed to fetch live best bid for slippage guard. Falling back to cached check or risk. " + String(err));
          }

          logger.info(`Win: selling ${position.side} for profit lock`);
          const ok = await sellToken(
            position.tokenId,
            shares,
            marketInfo.conditionId,
            marketInfo.eventSlug,
            position.side,
            "profit_lock",
            getBestBid
          );
          if (ok) await store.setPosition(marketInfo.conditionId, null);
        } else if (currentPrice <= stopLossPrice) {
          logger.info(`Win: stop loss ${currentPrice.toFixed(3)} <= ${stopLossPrice}, selling ${position.side}`);
          const ok = await sellToken(
            position.tokenId,
            shares,
            marketInfo.conditionId,
            marketInfo.eventSlug,
            position.side,
            "stop_loss",
            getBestBid
          );
          if (ok) await store.setPosition(marketInfo.conditionId, null);
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
