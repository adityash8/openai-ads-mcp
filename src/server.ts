import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AdsApiError, AdsClient } from "./client";
import {
  getApiKey,
  getServerConfig,
  resolveAccountKey,
  type ServerConfig,
} from "./config";
import { loadApprovalArtifact } from "./approvals";
import { assertGuardrailCheck, checkApprovedOperations } from "./guardrails";
import { writeAuditEvent } from "./audit";
import {
  draftCampaignBundleOperations,
  summarizeInsights,
  validateConversionEvent,
} from "./reports";
import {
  ApplyApprovedPlanSchema,
  CampaignBundleSchema,
  ConversionEventSchema,
  DraftAdUpdateSchema,
  InsightsQuerySchema,
  ListAdGroupsSchema,
  ListAdsSchema,
  ListCampaignsSchema,
  UploadImageSchema,
  type Operation,
} from "./schemas";

type JsonObject = Record<string, unknown>;

interface ServerDeps {
  config?: ServerConfig;
  fetchImpl?: typeof fetch;
}

export function createOpenAiAdsServer(deps: ServerDeps = {}) {
  const config = deps.config || getServerConfig();
  const server = new Server(
    {
      name: "openai-ads-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  function clientFor(accountKey: string) {
    return new AdsClient({
      baseUrl: config.baseUrl,
      apiKey: getApiKey(accountKey),
      fetchImpl: deps.fetchImpl,
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments || {}) as JsonObject;
    const agent = process.env.OPENAI_ADS_AGENT_NAME || "unknown";

    try {
      switch (request.params.name) {
        case "openai_ads_get_account": {
          const accountKey = resolveAccountKey(
            typeof args.account_key === "string" ? args.account_key : undefined,
            config
          );
          return jsonResult(await clientFor(accountKey).getAccount());
        }

        case "openai_ads_list_campaigns": {
          const parsed = ListCampaignsSchema.parse(args);
          const accountKey = resolveAccountKey(parsed.account_key, config);
          return jsonResult(await clientFor(accountKey).listCampaigns(parsed));
        }

        case "openai_ads_list_ad_groups": {
          const parsed = ListAdGroupsSchema.parse(args);
          const accountKey = resolveAccountKey(parsed.account_key, config);
          return jsonResult(await clientFor(accountKey).listAdGroups(parsed));
        }

        case "openai_ads_list_ads": {
          const parsed = ListAdsSchema.parse(args);
          const accountKey = resolveAccountKey(parsed.account_key, config);
          return jsonResult(await clientFor(accountKey).listAds(parsed));
        }

        case "openai_ads_get_insights": {
          const parsed = InsightsQuerySchema.parse(args);
          const accountKey = resolveAccountKey(parsed.account_key, config);
          const raw = await clientFor(accountKey).getInsights(parsed.level, parsed);
          return jsonResult({ raw, summary: summarizeInsights(raw) });
        }

        case "openai_ads_optimization_report": {
          const parsed = InsightsQuerySchema.parse(args);
          const accountKey = resolveAccountKey(parsed.account_key, config);
          const raw =
            "insights" in args
              ? args.insights
              : await clientFor(accountKey).getInsights(parsed.level, parsed);
          return jsonResult(summarizeInsights(raw));
        }

        case "openai_ads_upload_image": {
          const parsed = UploadImageSchema.parse(args);
          const accountKey = resolveAccountKey(parsed.account_key, config);
          if (!config.writeEnabled) {
            throw new Error("Image upload is disabled until OPENAI_ADS_ENABLE_WRITES=1.");
          }
          const result = await clientFor(accountKey).uploadImage(
            parsed.file_path,
            parsed.purpose
          );
          await writeAuditEvent(config.auditLogPath, {
            agent,
            account_key: accountKey,
            tool: request.params.name,
            status: "success",
            payload: { file_path: parsed.file_path, purpose: parsed.purpose },
          });
          return jsonResult(result);
        }

        case "openai_ads_draft_campaign_bundle": {
          const parsed = CampaignBundleSchema.parse(args);
          const accountKey = resolveAccountKey(parsed.account_key, config);
          const operations = draftCampaignBundleOperations(parsed);
          return jsonResult({
            account_key: accountKey,
            operations,
            approval_template: {
              id: `openai-ads-${new Date().toISOString().replace(/[:.]/g, "-")}`,
              account_key: accountKey,
              approved_by: "",
              approved_at: new Date().toISOString(),
              max_budget_micros: Math.max(0, ...collectOperationBudgets(operations)),
              approved_countries: [],
              allow_destructive: false,
              operations,
              notes: "Fill approved_by, approved_at, max_budget_micros, and approved_countries before applying.",
            },
          });
        }

        case "openai_ads_draft_ad_update": {
          const parsed = DraftAdUpdateSchema.parse(args);
          const accountKey = resolveAccountKey(parsed.account_key, config);
          const operation: Operation = {
            type: "update_ad",
            id: parsed.ad_id,
            payload: parsed.payload,
          };
          return jsonResult({ account_key: accountKey, operations: [operation] });
        }

        case "openai_ads_validate_conversion_event": {
          const event = ConversionEventSchema.parse(args);
          return jsonResult(validateConversionEvent(event));
        }

        case "openai_ads_apply_approved_plan": {
          const parsed = ApplyApprovedPlanSchema.parse(args);
          const accountKey = resolveAccountKey(parsed.account_key, config);
          const approval = await loadApprovalArtifact(
            config.approvalDir,
            parsed.approval_id
          );
          const operations = parsed.operations || approval.operations;
          const guardrail = checkApprovedOperations({
            writeEnabled: config.writeEnabled,
            requestedAccountKey: accountKey,
            approval,
            operations,
          });
          assertGuardrailCheck(guardrail);
          const results = await executeOperations(clientFor(accountKey), operations);
          await writeAuditEvent(config.auditLogPath, {
            agent,
            account_key: accountKey,
            tool: request.params.name,
            approval_id: parsed.approval_id,
            status: "success",
            payload: { operations },
          });
          return jsonResult({ results, warnings: guardrail.warnings });
        }

        default:
          throw new Error(`Unknown OpenAI Ads tool: ${request.params.name}`);
      }
    } catch (error) {
      const accountKey =
        typeof args.account_key === "string"
          ? args.account_key
          : config.defaultAccountKey;
      await writeAuditEvent(config.auditLogPath, {
        agent,
        account_key: accountKey,
        tool: request.params.name,
        status: "error",
        api_status: error instanceof AdsApiError ? error.status : undefined,
        message: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      return jsonResult(
        {
          error: error instanceof Error ? error.message : String(error),
          api_status: error instanceof AdsApiError ? error.status : undefined,
        },
        true
      );
    }
  });

  return server;
}

export async function startServer() {
  const server = createOpenAiAdsServer();
  await server.connect(new StdioServerTransport());
}

async function executeOperations(client: AdsClient, operations: Operation[]) {
  const refs: Record<string, unknown> = {};
  const results: unknown[] = [];

  for (const operation of operations) {
    const materialized = materialize(operation, refs) as Operation;
    const result = await executeOperation(client, materialized);
    results.push({ operation: materialized.type, result });

    const id = extractId(result);
    if (id) {
      if (materialized.type === "create_campaign") refs["campaign.id"] = id;
      if (materialized.type === "create_ad_group") refs["ad_group.id"] = id;
      if (materialized.type === "create_ad") refs["ad.id"] = id;
    }
  }

  return results;
}

function executeOperation(client: AdsClient, operation: Operation) {
  switch (operation.type) {
    case "create_campaign":
      return client.createCampaign(operation.payload);
    case "update_campaign":
      return client.updateCampaign(operation.id, operation.payload);
    case "campaign_state":
      return client.campaignState(operation.id, operation.action);
    case "create_ad_group":
      return client.createAdGroup(operation.payload);
    case "update_ad_group":
      return client.updateAdGroup(operation.id, operation.payload);
    case "ad_group_state":
      return client.adGroupState(operation.id, operation.action);
    case "create_ad":
      return client.createAd(operation.payload);
    case "update_ad":
      return client.updateAd(operation.id, operation.payload);
    case "ad_state":
      return client.adState(operation.id, operation.action);
  }
}

function materialize(value: unknown, refs: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const match = value.match(/^\{\{(.+)}}$/);
    return match ? refs[match[1]] || value : value;
  }
  if (Array.isArray(value)) return value.map((item) => materialize(item, refs));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        materialize(child, refs),
      ])
    );
  }
  return value;
}

function extractId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object.id === "string") return object.id;
  if (object.data && typeof object.data === "object") {
    const data = object.data as Record<string, unknown>;
    if (typeof data.id === "string") return data.id;
  }
  return undefined;
}

function collectOperationBudgets(operations: Operation[]) {
  const budgets: number[] = [];
  for (const operation of operations) {
    const payload = "payload" in operation ? operation.payload : undefined;
    if (!payload || typeof payload !== "object") continue;
    for (const [key, value] of Object.entries(payload)) {
      if (
        key.toLowerCase().includes("budget") &&
        key.toLowerCase().includes("micros") &&
        typeof value === "number"
      ) {
        budgets.push(value);
      }
    }
  }
  return budgets;
}

function jsonResult(value: unknown, isError = false) {
  return {
    isError,
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function toolDefinitions() {
  const accountKeyProperty = {
    type: "string",
    description: "Uppercase account key suffix, e.g. PRIMARY for OPENAI_ADS_PRIMARY_API_KEY.",
  };

  return [
    {
      name: "openai_ads_get_account",
      description: "Read the current OpenAI Ads account for the selected account key.",
      inputSchema: {
        type: "object",
        properties: { account_key: accountKeyProperty },
      },
    },
    {
      name: "openai_ads_list_campaigns",
      description: "List OpenAI Ads campaigns.",
      inputSchema: {
        type: "object",
        properties: {
          account_key: accountKeyProperty,
          limit: { type: "number" },
          after: { type: "string" },
          before: { type: "string" },
          status: { type: "string" },
        },
      },
    },
    {
      name: "openai_ads_list_ad_groups",
      description: "List OpenAI Ads ad groups, optionally filtered by campaign.",
      inputSchema: {
        type: "object",
        properties: {
          account_key: accountKeyProperty,
          campaign_id: { type: "string" },
          limit: { type: "number" },
          after: { type: "string" },
          before: { type: "string" },
          status: { type: "string" },
        },
      },
    },
    {
      name: "openai_ads_list_ads",
      description: "List OpenAI Ads ads, optionally filtered by ad group.",
      inputSchema: {
        type: "object",
        properties: {
          account_key: accountKeyProperty,
          ad_group_id: { type: "string" },
          limit: { type: "number" },
          after: { type: "string" },
          before: { type: "string" },
          status: { type: "string" },
        },
      },
    },
    {
      name: "openai_ads_get_insights",
      description: "Fetch OpenAI Ads insights and include a computed summary.",
      inputSchema: {
        type: "object",
        properties: {
          account_key: accountKeyProperty,
          level: { type: "string", enum: ["account", "campaign", "ad_group", "ad"] },
          id: { type: "string" },
          date_from: { type: "string" },
          date_to: { type: "string" },
          granularity: { type: "string" },
          time_granularity: { type: "string" },
          aggregation_level: { type: "string" },
          fields: { type: "array", items: { type: "string" } },
          limit: { type: "number" },
        },
      },
    },
    {
      name: "openai_ads_optimization_report",
      description: "Summarize Ads insights and produce conservative optimization recommendations.",
      inputSchema: {
        type: "object",
        properties: {
          account_key: accountKeyProperty,
          level: { type: "string", enum: ["account", "campaign", "ad_group", "ad"] },
          id: { type: "string" },
          date_from: { type: "string" },
          date_to: { type: "string" },
          granularity: { type: "string" },
          time_granularity: { type: "string" },
          aggregation_level: { type: "string" },
          fields: { type: "array", items: { type: "string" } },
          limit: { type: "number" },
          insights: { type: "object" },
        },
      },
    },
    {
      name: "openai_ads_upload_image",
      description: "Upload an image asset to OpenAI Ads. Requires OPENAI_ADS_ENABLE_WRITES=1.",
      inputSchema: {
        type: "object",
        properties: {
          account_key: accountKeyProperty,
          file_path: { type: "string" },
          purpose: { type: "string" },
        },
        required: ["file_path"],
      },
    },
    {
      name: "openai_ads_draft_campaign_bundle",
      description: "Draft paused campaign, ad group, and ad creation operations for approval.",
      inputSchema: {
        type: "object",
        properties: {
          account_key: accountKeyProperty,
          campaign: { type: "object" },
          ad_group: { type: "object" },
          ads: { type: "array", items: { type: "object" } },
        },
        required: ["campaign", "ad_group", "ads"],
      },
    },
    {
      name: "openai_ads_draft_ad_update",
      description: "Draft an ad update operation for approval.",
      inputSchema: {
        type: "object",
        properties: {
          account_key: accountKeyProperty,
          ad_id: { type: "string" },
          payload: { type: "object" },
        },
        required: ["ad_id", "payload"],
      },
    },
    {
      name: "openai_ads_validate_conversion_event",
      description: "Validate an OpenAI Ads Pixel/CAPI conversion event shape and timestamp.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string" },
          timestamp_ms: { type: "number" },
          data: { type: "object" },
          metadata: { type: "object" },
        },
        required: ["type"],
      },
    },
    {
      name: "openai_ads_apply_approved_plan",
      description: "Apply approved OpenAI Ads operations. Requires approval artifact and OPENAI_ADS_ENABLE_WRITES=1.",
      inputSchema: {
        type: "object",
        properties: {
          account_key: accountKeyProperty,
          approval_id: { type: "string" },
          operations: { type: "array", items: { type: "object" } },
        },
        required: ["approval_id"],
      },
    },
  ];
}
