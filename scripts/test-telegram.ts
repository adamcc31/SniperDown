import { config } from "dotenv";
config();
import {
  sendStartPing,
  sendHeartbeat,
  sendOrderExecution,
  sendOrderResult,
  sendClaimedPrize,
  sendActionAborted,
  sendDryRunSummary
} from "../src/services/telegram-reporter";
import { recordMockTrade, recordMockWin, deductPaperBalance } from "../src/services/paper-ledger";
import { tradingEnv } from "../src/config/env";

console.log(`Testing Telegram Notifications in mode DRY_RUN=${tradingEnv.DRY_RUN_MODE}...`);

recordMockTrade();
recordMockTrade();
recordMockWin();
deductPaperBalance(10.50);

console.log("Sending Start Ping...");
sendStartPing();

setTimeout(() => { console.log("Sending Heartbeat..."); sendHeartbeat(); }, 2000);
setTimeout(() => { console.log("Sending Order Execution..."); sendOrderExecution("Down", "BUY Market (FAK)", 0.82, 50.0); }, 4000);
setTimeout(() => { console.log("Sending Order Result..."); sendOrderResult("SUCCESS", "Filled 60.97 shares of Down."); }, 6000);
setTimeout(() => { console.log("Sending Claimed Prize..."); sendClaimedPrize(50.0); }, 8000);
setTimeout(() => { console.log("Sending Action Aborted..."); sendActionAborted("KILL SWITCH", "48-Hour simulation period complete."); }, 10000);
setTimeout(() => { console.log("Sending Dry Run Summary..."); sendDryRunSummary("2.00h"); }, 12000);

setTimeout(() => {
  console.log("Done! Please check your Telegram client.");
  process.exit(0);
}, 14000);
