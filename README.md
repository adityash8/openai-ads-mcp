# OpenAI Ads MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server for OpenAI's
ChatGPT Ads platform — read campaigns/ad groups/ads, pull insights, draft
optimization plans, and apply **approval-gated** live mutations. Built for use
from Claude, OpenClaw, Hermes, or any MCP-compatible agent.

> [!IMPORTANT]
> **You need OpenAI Ads API access to actually run this against live data.**
> The server talks to `https://api.ads.openai.com/v1` with a Bearer key. As of
> mid-2026, OpenAI's ChatGPT Ads is an **invite/beta program** — there is no
> public self-serve Ads API, only a web Ads Manager and a measurement
> pixel/Conversions API. Without a key for that endpoint, the network-backed
> tools fail fast with a `Missing OPENAI_ADS_<ACCOUNT>_API_KEY` error before
> making any network call.
>
> **So treat this repo as a reference / template MCP**: a working blueprint for
> wrapping OpenAI Ads as an agent tool, ready to use the moment you have API
> access. The draft/report/validation tools that don't hit the network work
> standalone, and the test suite runs fully offline against a mocked client.

## Safety model

- **API keys come from environment variables only** — never hardcoded, never in
  source. A key pasted into a chat or log should be considered compromised; rotate it.
- **Read / report / draft tools are available by default** and are non-destructive.
- **Live mutations are double-gated.** A write executes only when both are true:
  - `OPENAI_ADS_ENABLE_WRITES=1`, and
  - a matching approval artifact exists at `tasks/openai-ads/approvals/<id>.json`
    inside this repo (shape below) whose declared budget/countries/destructiveness
    bound the operation.
- **Every mutation is audit-logged** to `tasks/openai-ads/audit.jsonl` (gitignored).

Approval/audit paths resolve relative to this package's directory by default;
override with `OPENAI_ADS_REPO_ROOT`, `OPENAI_ADS_APPROVAL_DIR`, or
`OPENAI_ADS_AUDIT_LOG`.

## Quick start

First, clone and install (all three clients need this). Requires
[Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`.

```bash
git clone https://github.com/adityash8/openai-ads-mcp.git
cd openai-ads-mcp
bun install
```

One env var is all you need: `OPENAI_ADS_PRIMARY_API_KEY`. No key yet? Skip it —
the server starts fine and the four offline tools work; only the network-backed
tools need a key. Then pick your client below.

### Claude Code

From inside the cloned directory, one command (`$PWD` expands to the absolute
path at add-time):

```bash
claude mcp add --env OPENAI_ADS_PRIMARY_API_KEY=YOUR_KEY --transport stdio openai-ads -- bun "$PWD/index.ts"
```

This registers it for the current project. Add `--scope user` (before the
`openai-ads` name) to make it available in every project. Verify with
`claude mcp list`, then use it in a session: *"list my OpenAI Ads campaigns."*

### Claude Desktop

Edit the config file (**Settings → Developer → Edit Config**, or directly):

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add the server (use the **absolute** path to `index.ts`), then fully quit and
reopen Claude Desktop:

```json
{
  "mcpServers": {
    "openai-ads": {
      "command": "bun",
      "args": ["/absolute/path/to/openai-ads-mcp/index.ts"],
      "env": {
        "OPENAI_ADS_PRIMARY_API_KEY": "YOUR_KEY"
      }
    }
  }
}
```

The tools appear under the 🔌 / tools menu once the server connects.

### ChatGPT

> [!WARNING]
> ChatGPT is more involved than Claude. ChatGPT's custom connectors **only
> accept remote HTTPS MCP servers** (SSE / streaming HTTP) — it cannot launch a
> local stdio server. So you bridge this server to HTTP and expose it over a
> tunnel. Requires a **paid plan** (Plus, Pro, Business, Enterprise, or Edu);
> Developer Mode is not on Free.

1. **Bridge stdio → SSE** with [supergateway](https://github.com/supercorp-ai/supergateway):

   ```bash
   OPENAI_ADS_PRIMARY_API_KEY=YOUR_KEY \
     npx -y supergateway --stdio "bun index.ts" --port 8000 --ssePath /sse
   ```

2. **Expose it over HTTPS** with a tunnel (ChatGPT must reach it from the
   internet) — e.g. [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
   or [ngrok](https://ngrok.com):

   ```bash
   cloudflared tunnel --url http://localhost:8000   # prints an https://… URL
   ```

3. **Add the connector in ChatGPT:** Settings → Apps → Advanced →
   **Developer mode** (enable) → **Create app**. Set the MCP server URL to your
   tunnel's `https://…/sse` endpoint. It lands under "Drafts," then is callable
   in chat.

> [!CAUTION]
> A tunnel puts this server on the public internet. Keep
> `OPENAI_ADS_ENABLE_WRITES=0` (the default) so it stays read-only, put auth on
> the tunnel (supergateway `--header "Authorization: Bearer …"`, or a
> Cloudflare Access policy), and shut the tunnel down when you're done. Treat
> the URL as a secret.

### Configuration details

- **Multiple ad accounts:** each account is an uppercase **account key**; its
  key is read from `OPENAI_ADS_<ACCOUNT_KEY>_API_KEY` (e.g. add
  `OPENAI_ADS_BRANDX_API_KEY` and pass `account_key: "BRANDX"` in tool calls).
  The default account key is `PRIMARY`; change it with
  `OPENAI_ADS_DEFAULT_ACCOUNT`.
- **Writes are off by default.** Set `OPENAI_ADS_ENABLE_WRITES=1` *and* supply
  an approval artifact (below) to enable mutations.
- **Pass env vars through your MCP client config** (the `env` block / `--env`
  flag), as shown above. A local `.env` works too, but only when running under
  Bun from this directory — `node dist/index.js` and MCP clients launched from
  other working directories won't read it.
- **Prefer a Node runtime?** `bun run build` once, then point your client at
  `node /absolute/path/to/openai-ads-mcp/dist/index.js` (Node 18+). Bun is
  still required for build/test — plain Node can't run the TypeScript source.

## Tools

| Tool | Network | Purpose |
|------|:------:|---------|
| `openai_ads_get_account` | ✓ | Fetch the resolved ad account |
| `openai_ads_list_campaigns` | ✓ | List campaigns |
| `openai_ads_list_ad_groups` | ✓ | List ad groups |
| `openai_ads_list_ads` | ✓ | List ads |
| `openai_ads_get_insights` | ✓ | Account / campaign / ad-group / ad insights |
| `openai_ads_optimization_report` | ✓ | Summarize insights into an optimization read |
| `openai_ads_upload_image` | ✓ | Upload a creative image |
| `openai_ads_draft_campaign_bundle` | — | Build a campaign→ad-group→ads operation set (no writes) |
| `openai_ads_draft_ad_update` | — | Draft an ad-update operation (no writes) |
| `openai_ads_validate_conversion_event` | — | Validate a conversion event against the supported schema |
| `openai_ads_apply_approved_plan` | ✓ | Execute an approved, gated set of mutations |

## Approval artifact shape

`operations` must contain at least one entry. Valid operation types:
`create_campaign`, `update_campaign`, `campaign_state`, `create_ad_group`,
`update_ad_group`, `ad_group_state`, `create_ad`, `update_ad`, `ad_state`.
State operations take `{ "id": "...", "action": "activate" | "pause" | "archive" }`.

```json
{
  "id": "example-approval",
  "account_key": "PRIMARY",
  "approved_by": "you",
  "approved_at": "2026-06-02T00:00:00.000Z",
  "max_budget_micros": 10000000,
  "approved_countries": ["US"],
  "allow_destructive": false,
  "operations": [
    { "type": "ad_state", "id": "ad_123", "action": "pause" }
  ]
}
```

## Conversion event shape

`openai_ads_validate_conversion_event` expects:

```json
{
  "type": "order_created",
  "timestamp_ms": 1764547200000,
  "data": {}
}
```

`type` must be one of: `appointment_scheduled`, `checkout_started`,
`contents_viewed`, `custom`, `items_added`, `lead_created`, `order_created`,
`page_viewed`, `registration_completed`, `subscription_created`,
`trial_started`. `id`, `timestamp_ms`, and `metadata` are optional.

## Develop

```bash
bun test          # offline — uses a mocked Ads client
bun run build     # bundle index.ts -> dist/ (Node target)
```

### Live read-only probe

After setting a real key, verify connectivity without changing anything:

```bash
bun run probe:live -- --account PRIMARY
```

Checks the ad account, campaign listing, and account insights. For insights,
`time_granularity` is `none` or `daily` (`all` / `day` are accepted aliases and
normalized). Metric arrays encode as `fields[]=impressions&fields[]=clicks`.

## License

MIT © 2026 Aditya Sheth. See [LICENSE](LICENSE).
