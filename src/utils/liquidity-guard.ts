import { getClobClient } from "../providers/clobclient";
import { logger } from "../logger";

export async function checkLiquidity(
  tokenId: string,
  maxPrice: number,
  minVolume: number
): Promise<boolean> {
  try {
    const client = await getClobClient();
    const orderbook = await client.getOrderBook(tokenId);
    
    let totalVolume = 0;
    if (orderbook && orderbook.asks) {
      for (const ask of orderbook.asks) {
        const price = parseFloat(ask.price);
        if (price <= maxPrice) {
          totalVolume += parseFloat(ask.size);
        }
      }
    }
    
    return totalVolume >= minVolume;
  } catch (error) {
    logger.error(`[LiquidityGuard] Error — failing open: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
}
