import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_APPROVAL_DIR,
  DEFAULT_AUDIT_LOG,
  DEFAULT_BASE_URL,
} from "./schemas";

export interface ServerConfig {
  repoRoot: string;
  baseUrl: string;
  defaultAccountKey: string;
  approvalDir: string;
  auditLogPath: string;
  writeEnabled: boolean;
}

export function getServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  const repoRoot = env.OPENAI_ADS_REPO_ROOT || packageRoot;
  const approvalDir =
    env.OPENAI_ADS_APPROVAL_DIR || path.join(repoRoot, DEFAULT_APPROVAL_DIR);
  const auditLogPath =
    env.OPENAI_ADS_AUDIT_LOG || path.join(repoRoot, DEFAULT_AUDIT_LOG);

  return {
    repoRoot,
    baseUrl: env.OPENAI_ADS_BASE_URL || DEFAULT_BASE_URL,
    defaultAccountKey: env.OPENAI_ADS_DEFAULT_ACCOUNT || "PRIMARY",
    approvalDir,
    auditLogPath,
    writeEnabled: env.OPENAI_ADS_ENABLE_WRITES === "1",
  };
}

export function resolveAccountKey(
  requestedAccountKey: string | undefined,
  config: ServerConfig
): string {
  return requestedAccountKey || config.defaultAccountKey;
}

export function apiKeyEnvName(accountKey: string): string {
  return `OPENAI_ADS_${accountKey}_API_KEY`;
}

export function getApiKey(
  accountKey: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const value = env[apiKeyEnvName(accountKey)];
  if (!value) {
    throw new Error(
      `Missing ${apiKeyEnvName(accountKey)}. Rotate exposed keys and set the env var before using live Ads tools.`
    );
  }
  return value;
}
