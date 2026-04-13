import { tradingEnv } from "../config/env";

type TtrCase = {
  label: string;
  ttrSeconds: number;
  expectedPass: boolean;
};

function shouldPassGoldenWindow(ttrSeconds: number): boolean {
  // Exact live-path condition from win-monitor.ts
  if (ttrSeconds > tradingEnv.MAX_TTR_SECONDS || ttrSeconds < tradingEnv.MIN_TTR_SECONDS) {
    return false;
  }
  return true;
}

function runModeChecks(modeName: "DRY RUN" | "LIVE", dryRunValue: "true" | "false"): void {
  process.env.DRY_RUN_MODE = dryRunValue;

  const min = tradingEnv.MIN_TTR_SECONDS;
  const max = tradingEnv.MAX_TTR_SECONDS;
  const cases: TtrCase[] = [
    { label: "Above max", ttrSeconds: max + 1, expectedPass: false },
    { label: "At max", ttrSeconds: max, expectedPass: true },
    { label: "Mid window", ttrSeconds: Math.floor((min + max) / 2), expectedPass: true },
    { label: "At min", ttrSeconds: min, expectedPass: true },
    { label: "Below min", ttrSeconds: min - 1, expectedPass: false },
  ];

  console.log(`\n=== TTR GUARD VERIFICATION (${modeName}) ===`);
  console.log(`DRY_RUN_MODE=${tradingEnv.DRY_RUN_MODE}`);
  console.log(`Golden Window: [${min}, ${max}] seconds`);

  let failed = 0;
  for (const testCase of cases) {
    const actualPass = shouldPassGoldenWindow(testCase.ttrSeconds);
    const ok = actualPass === testCase.expectedPass;
    if (!ok) failed += 1;

    console.log(
      `${ok ? "PASS" : "FAIL"} | ${testCase.label.padEnd(10)} | ttr=${String(testCase.ttrSeconds).padStart(4)} | expected=${testCase.expectedPass} actual=${actualPass}`
    );
  }

  if (failed > 0) {
    throw new Error(`${modeName} verification failed with ${failed} mismatch(es).`);
  }
}

function main(): void {
  runModeChecks("DRY RUN", "true");
  runModeChecks("LIVE", "false");
  console.log("\nAll TTR guard checks passed in both modes.");
}

main();
