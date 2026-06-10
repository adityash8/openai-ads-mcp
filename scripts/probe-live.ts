#!/usr/bin/env bun
import { getServerConfig } from "../src/config";
import { missingKeyHint, runLiveReadOnlyProbe } from "../src/liveProbe";

const accountArgIndex = process.argv.findIndex((arg) => arg === "--account");
const config = getServerConfig();
const accountKey =
  accountArgIndex >= 0 ? process.argv[accountArgIndex + 1] : config.defaultAccountKey;

if (!accountKey) {
  console.error("Missing account key after --account.");
  process.exit(2);
}

try {
  const result = await runLiveReadOnlyProbe({ accountKey, config });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(missingKeyHint(accountKey));
  process.exit(1);
}
