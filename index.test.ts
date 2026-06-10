import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdsApiError, AdsClient } from "./src/client";
import { redact } from "./src/audit";
import { checkApprovedOperations } from "./src/guardrails";
import {
  draftCampaignBundleOperations,
  summarizeInsights,
  validateConversionEvent,
} from "./src/reports";
import { createOpenAiAdsServer } from "./src/server";
import { missingKeyHint, runLiveReadOnlyProbe } from "./src/liveProbe";
import type { ApprovalArtifact, Operation } from "./src/schemas";

describe("AdsClient", () => {
  test("constructs authenticated JSON requests with query params", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init || {} });
      return Response.json({ data: [{ id: "camp_1" }] });
    };
    const client = new AdsClient({
      baseUrl: "https://api.ads.openai.com/v1/",
      apiKey: "secret-key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.listCampaigns({ limit: 25, after: undefined, status: "paused" });

    expect(calls[0].url).toBe(
      "https://api.ads.openai.com/v1/campaigns?limit=25&status=paused"
    );
    expect(calls[0].init.method).toBe("GET");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-key"
    );
  });

  test("encodes insights arrays and normalizes granularity aliases", async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request) => {
      calls.push(String(url));
      return Response.json({ data: [] });
    };
    const client = new AdsClient({
      baseUrl: "https://api.ads.openai.com/v1",
      apiKey: "secret-key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await client.getInsights("account", {
      account_key: "PRIMARY",
      level: "account",
      time_granularity: "day",
      fields: ["impressions", "clicks", "spend"],
    });

    expect(calls[0]).toBe(
      "https://api.ads.openai.com/v1/ad_account/insights?time_granularity=daily&fields%5B%5D=impressions&fields%5B%5D=clicks&fields%5B%5D=spend"
    );
  });

  test("throws structured errors without exposing auth headers", async () => {
    const client = new AdsClient({
      baseUrl: "https://api.ads.openai.com/v1",
      apiKey: "secret-key",
      fetchImpl: (async () =>
        Response.json({ error: { message: "bad" } }, { status: 429 })) as typeof fetch,
    });

    await expect(client.getAccount()).rejects.toMatchObject({
      name: "AdsApiError",
      status: 429,
    } satisfies Partial<AdsApiError>);
  });
});

describe("draft operations", () => {
  test("drafts a paused campaign bundle with placeholder references", () => {
    const operations = draftCampaignBundleOperations({
      campaign: {
        name: "JB Trial",
        countries: ["US"],
        daily_budget_micros: 10_000_000,
      },
      ad_group: {
        name: "Founder ICP",
        billing_event_type: "impression",
      },
      ads: [
        {
          name: "Hook A",
          creative: {
            type: "chat_card",
            title: "Find buyers faster",
            body: "Qualify acquisition leads with AI.",
            target_url: "https://example.com",
            file_id: "file_123",
          },
        },
      ],
    });

    expect(operations.map((operation) => operation.type)).toEqual([
      "create_campaign",
      "create_ad_group",
      "create_ad",
    ]);
    expect(operations[1]).toMatchObject({
      payload: { campaign_id: "{{campaign.id}}", status: "paused" },
    });
    expect(operations[2]).toMatchObject({
      payload: { ad_group_id: "{{ad_group.id}}", status: "paused" },
    });
  });
});

describe("guardrails", () => {
  const operations: Operation[] = [
    {
      type: "create_campaign",
      payload: {
        name: "JB Trial",
        countries: ["US"],
        daily_budget_micros: 5_000_000,
      },
    },
  ];

  const approval: ApprovalArtifact = {
    id: "approval_1",
    account_key: "PRIMARY",
    approved_by: "Aditya",
    approved_at: new Date("2026-06-02T00:00:00.000Z").toISOString(),
    max_budget_micros: 6_000_000,
    approved_countries: ["US"],
    allow_destructive: false,
    operations,
  };

  test("allows matching approved operations when writes are enabled", () => {
    const check = checkApprovedOperations({
      writeEnabled: true,
      requestedAccountKey: "PRIMARY",
      approval,
      operations,
    });

    expect(check.ok).toBe(true);
    expect(check.errors).toEqual([]);
  });

  test("rejects disabled writes and over-budget operations", () => {
    const check = checkApprovedOperations({
      writeEnabled: false,
      requestedAccountKey: "PRIMARY",
      approval,
      operations: [
        {
          type: "create_campaign",
          payload: { name: "Too Big", countries: ["US"], daily_budget_micros: 9_000_000 },
        },
      ],
    });

    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toContain("Writes are disabled");
    expect(check.errors.join(" ")).toContain("Approval operations do not match");
    expect(check.errors.join(" ")).toContain("exceeds approval");
  });

  test("rejects archive operations without explicit destructive approval", () => {
    const destructive: Operation[] = [
      { type: "campaign_state", id: "camp_1", action: "archive" },
    ];
    const check = checkApprovedOperations({
      writeEnabled: true,
      requestedAccountKey: "PRIMARY",
      approval: { ...approval, operations: destructive },
      operations: destructive,
    });

    expect(check.ok).toBe(false);
    expect(check.errors.join(" ")).toContain("allow_destructive");
  });
});

describe("reports and events", () => {
  test("summarizes insights and flags weak CTR", () => {
    const report = summarizeInsights({
      data: [
        { impressions: 1000, clicks: 2, spend_micros: 4_000_000, ad_id: "ad_1" },
        { impressions: 600, clicks: 0, spend_micros: 1_000_000, ad_id: "ad_2" },
      ],
    });

    expect(report.totals.impressions).toBe(1600);
    expect(report.totals.clicks).toBe(2);
    expect(report.totals.spend).toBe(5);
    expect(report.recommendations.join(" ")).toContain("CTR is below");
    expect(report.recommendations.join(" ")).toContain("zero clicks");
  });

  test("validates conversion event timestamp limits", () => {
    const now = new Date("2026-06-02T00:00:00.000Z").getTime();
    const result = validateConversionEvent(
      {
        type: "lead_created",
        timestamp_ms: now - 8 * 24 * 60 * 60 * 1000,
        data: {},
      },
      now
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("last 7 days");
    expect(result.warnings.join(" ")).toContain("Missing event id");
  });

  test("redacts nested secret-looking fields", () => {
    expect(
      redact({
        Authorization: "Bearer secret",
        nested: { api_key: "secret", safe: "value" },
      })
    ).toEqual({
      Authorization: "[REDACTED]",
      nested: { api_key: "[REDACTED]", safe: "value" },
    });
  });
});

describe("MCP protocol", () => {
  test("lists tools and calls safe draft/validation tools without credentials", async () => {
    const server = createOpenAiAdsServer({
      config: {
        repoRoot: "/tmp/openai-ads-test",
        baseUrl: "https://api.ads.openai.com/v1",
        defaultAccountKey: "PRIMARY",
        approvalDir: "/tmp/openai-ads-test/approvals",
        auditLogPath: "/tmp/openai-ads-test/audit.jsonl",
        writeEnabled: false,
      },
    });
    const client = new Client({
      name: "openai-ads-test-client",
      version: "0.1.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);

      expect(names).toContain("openai_ads_draft_campaign_bundle");
      expect(names).toContain("openai_ads_validate_conversion_event");
      expect(names).toContain("openai_ads_apply_approved_plan");

      const draft = await client.callTool({
        name: "openai_ads_draft_campaign_bundle",
        arguments: {
          campaign: {
            name: "MCP Smoke",
            countries: ["US"],
            daily_budget_micros: 1_000_000,
          },
          ad_group: {
            name: "Founders",
            billing_event_type: "impression",
          },
          ads: [
            {
              name: "Smoke Hook",
              creative: {
                type: "chat_card",
                title: "Find buyers faster",
                body: "Qualify acquisition leads with AI.",
                target_url: "https://example.com",
                file_id: "file_smoke",
              },
            },
          ],
        },
      });
      const draftText = (draft.content[0] as { text: string }).text;
      const draftJson = JSON.parse(draftText);

      expect(draftJson.account_key).toBe("PRIMARY");
      expect(draftJson.operations.map((operation: Operation) => operation.type)).toEqual([
        "create_campaign",
        "create_ad_group",
        "create_ad",
      ]);

      const event = await client.callTool({
        name: "openai_ads_validate_conversion_event",
        arguments: {
          id: "evt_smoke",
          type: "lead_created",
          data: { value: 1 },
        },
      });
      const eventJson = JSON.parse((event.content[0] as { text: string }).text);

      expect(eventJson.ok).toBe(true);
      expect(eventJson.event.type).toBe("lead_created");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("applies an approved campaign bundle with ID materialization and audit logging", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openai-ads-apply-"));
    const approvalDir = join(tempDir, "approvals");
    const auditLogPath = join(tempDir, "audit.jsonl");
    await mkdir(approvalDir, { recursive: true });

    const operations = draftCampaignBundleOperations({
      campaign: {
        name: "Approved Smoke",
        countries: ["US"],
        daily_budget_micros: 1_000_000,
      },
      ad_group: {
        name: "Founders",
        billing_event_type: "impression",
      },
      ads: [
        {
          name: "Approved Hook",
          creative: {
            type: "chat_card",
            title: "Find buyers faster",
            body: "Qualify acquisition leads with AI.",
            target_url: "https://example.com",
            file_id: "file_smoke",
          },
        },
      ],
    });
    await writeFile(
      join(approvalDir, "approval-smoke.json"),
      `${JSON.stringify({
        id: "approval-smoke",
        account_key: "PRIMARY",
        approved_by: "Aditya",
        approved_at: "2026-06-02T00:00:00.000Z",
        max_budget_micros: 1_000_000,
        approved_countries: ["US"],
        allow_destructive: false,
        operations,
      })}\n`
    );

    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      requests.push({ path: parsed.pathname, body });

      if (parsed.pathname.endsWith("/campaigns")) {
        return Response.json({ id: "camp_created" });
      }
      if (parsed.pathname.endsWith("/ad_groups")) {
        return Response.json({ id: "ag_created" });
      }
      if (parsed.pathname.endsWith("/ads")) {
        return Response.json({ id: "ad_created" });
      }

      return Response.json({ error: "unexpected" }, { status: 404 });
    }) as typeof fetch;

    const oldKey = process.env.OPENAI_ADS_PRIMARY_API_KEY;
    process.env.OPENAI_ADS_PRIMARY_API_KEY = "rotated-test-key";
    const server = createOpenAiAdsServer({
      config: {
        repoRoot: tempDir,
        baseUrl: "https://api.ads.openai.com/v1",
        defaultAccountKey: "PRIMARY",
        approvalDir,
        auditLogPath,
        writeEnabled: true,
      },
      fetchImpl,
    });
    const client = new Client({
      name: "openai-ads-apply-test-client",
      version: "0.1.0",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const result = await client.callTool({
        name: "openai_ads_apply_approved_plan",
        arguments: {
          approval_id: "approval-smoke",
          account_key: "PRIMARY",
        },
      });
      const resultJson = JSON.parse((result.content[0] as { text: string }).text);

      expect(result.isError).toBeFalsy();
      expect(resultJson.results.map((item: { operation: string }) => item.operation)).toEqual([
        "create_campaign",
        "create_ad_group",
        "create_ad",
      ]);
      expect(requests.map((request) => request.path)).toEqual([
        "/v1/campaigns",
        "/v1/ad_groups",
        "/v1/ads",
      ]);
      expect(requests[1].body.campaign_id).toBe("camp_created");
      expect(requests[2].body.ad_group_id).toBe("ag_created");

      const audit = await readFile(auditLogPath, "utf8");
      expect(audit).toContain("\"approval_id\":\"approval-smoke\"");
      expect(audit).toContain("\"payload_hash\"");
      expect(audit).not.toContain("rotated-test-key");
    } finally {
      if (oldKey === undefined) {
        delete process.env.OPENAI_ADS_PRIMARY_API_KEY;
      } else {
        process.env.OPENAI_ADS_PRIMARY_API_KEY = oldKey;
      }
      await client.close();
      await server.close();
    }
  });
});

describe("live read-only probe", () => {
  test("checks account, campaigns, and account insights with a rotated env key", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      calls.push(`${parsed.pathname}${parsed.search}`);

      if (parsed.pathname.endsWith("/ad_account")) {
        return Response.json({
          id: "acct_123",
          name: "Primary Account",
          currency: "USD",
          timezone: "America/New_York",
        });
      }

      if (parsed.pathname.endsWith("/campaigns")) {
        return Response.json({ data: [{ id: "camp_1" }, { id: "camp_2" }] });
      }

      if (parsed.pathname.endsWith("/ad_account/insights")) {
        return Response.json({
          data: [{ impressions: 1000, clicks: 20, spend_micros: 5_000_000 }],
        });
      }

      return Response.json({ error: "unexpected" }, { status: 404 });
    }) as typeof fetch;

    const result = await runLiveReadOnlyProbe({
      accountKey: "PRIMARY",
      env: { OPENAI_ADS_PRIMARY_API_KEY: "rotated-test-key" },
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.endpoints.get_account.summary).toMatchObject({
      id: "acct_123",
      name: "Primary Account",
    });
    expect(result.endpoints.list_campaigns.summary).toMatchObject({
      count: 2,
      ids: ["camp_1", "camp_2"],
    });
    expect(result.endpoints.get_account_insights.summary).toMatchObject({
      totals: { impressions: 1000, clicks: 20, spend: 5 },
    });
    expect(calls.sort()).toEqual([
      "/v1/ad_account",
      "/v1/ad_account/insights?limit=100&time_granularity=none&fields%5B%5D=impressions&fields%5B%5D=clicks&fields%5B%5D=spend",
      "/v1/campaigns?limit=10",
    ]);
  });

  test("explains the missing rotated key without echoing secrets", async () => {
    await expect(
      runLiveReadOnlyProbe({
        accountKey: "PRIMARY",
        env: {},
      })
    ).rejects.toThrow("Missing OPENAI_ADS_PRIMARY_API_KEY");
    expect(missingKeyHint("PRIMARY")).toContain("rotated OpenAI Ads key");
  });
});
