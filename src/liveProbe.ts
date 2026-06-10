import { AdsApiError, AdsClient } from "./client";
import {
  apiKeyEnvName,
  getApiKey,
  getServerConfig,
  type ServerConfig,
} from "./config";
import { summarizeInsights } from "./reports";

export interface LiveProbeOptions {
  accountKey?: string;
  config?: ServerConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export interface LiveProbeResult {
  ok: boolean;
  account_key: string;
  checked_at: string;
  endpoints: {
    get_account: ProbeEndpoint;
    list_campaigns: ProbeEndpoint;
    get_account_insights: ProbeEndpoint;
  };
}

export interface ProbeEndpoint {
  ok: boolean;
  status?: number;
  summary?: unknown;
  error?: string;
}

export async function runLiveReadOnlyProbe(
  options: LiveProbeOptions = {}
): Promise<LiveProbeResult> {
  const config = options.config || getServerConfig(options.env);
  const accountKey = options.accountKey || config.defaultAccountKey;
  const apiKey = getApiKey(accountKey, options.env);
  const client = new AdsClient({
    baseUrl: config.baseUrl,
    apiKey,
    fetchImpl: options.fetchImpl,
  });

  const [account, campaigns, insights] = await Promise.all([
    captureEndpoint(() => client.getAccount(), summarizeAccount),
    captureEndpoint(() => client.listCampaigns({ limit: 10 }), summarizeList),
    captureEndpoint(
      () =>
        client.getInsights("account", {
          limit: 100,
          time_granularity: "none",
          fields: ["impressions", "clicks", "spend"],
        }),
      (raw) => summarizeInsights(raw)
    ),
  ]);

  return {
    ok: account.ok && campaigns.ok && insights.ok,
    account_key: accountKey,
    checked_at: new Date().toISOString(),
    endpoints: {
      get_account: account,
      list_campaigns: campaigns,
      get_account_insights: insights,
    },
  };
}

export function missingKeyHint(accountKey: string) {
  return `Set ${apiKeyEnvName(accountKey)} to a rotated OpenAI Ads key before running the live probe.`;
}

async function captureEndpoint(
  request: () => Promise<unknown>,
  summarize: (raw: unknown) => unknown
): Promise<ProbeEndpoint> {
  try {
    const raw = await request();
    return {
      ok: true,
      summary: summarize(raw),
    };
  } catch (error) {
    return {
      ok: false,
      status: error instanceof AdsApiError ? error.status : undefined,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeAccount(raw: unknown) {
  if (!raw || typeof raw !== "object") return raw;
  const object = raw as Record<string, unknown>;
  return {
    id: object.id,
    name: object.name,
    currency: object.currency,
    timezone: object.timezone,
    raw_keys: Object.keys(object).sort(),
  };
}

function summarizeList(raw: unknown) {
  const rows = extractRows(raw);
  return {
    count: rows.length,
    ids: rows
      .map((row) => (row && typeof row === "object" ? (row as Record<string, unknown>).id : undefined))
      .filter(Boolean),
    raw_shape: raw && typeof raw === "object" ? Object.keys(raw).sort() : typeof raw,
  };
}

function extractRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const object = raw as Record<string, unknown>;
  for (const key of ["data", "results", "rows", "campaigns"]) {
    if (Array.isArray(object[key])) return object[key] as unknown[];
  }
  return [];
}
