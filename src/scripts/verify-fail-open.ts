import { checkLiquidity } from "../utils/liquidity-guard";
import * as clobProvider from "../providers/clobclient";

/**
 * PHASE 2 FAIL-OPEN VERIFICATION
 */

async function verifyFailOpen() {
  console.log("\n--- Liquidity Guard Fail-Open Verification ---");
  
  // Mock getClobClient to throw
  (clobProvider as any).getClobClient = async () => {
    throw new Error("Network Timeout Simulation");
  };

  console.log("Calling checkLiquidity (should catch error and return true)...");
  const res = await checkLiquidity("any-id", 0.5, 10);
  
  if (res === true) {
    console.log("✅ Fail-Open Working: Returned true on error.");
  } else {
    console.error("❌ Fail-Open Failed: Returned false on error.");
  }
}

verifyFailOpen();
