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
> tools will return auth errors.
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
    (shape below) whose declared budget/countries/destructiveness bound the operation.
- **Every mutation is audit-logged** to `tasks/openai-ads/audit.jsonl` (gitignored).

## Install

```bash
bun install            # or: npm install
cp .env.example .env   # then fill in your key(s)
```

Requires [Bun](https://bun.sh) for dev/test. The built `dist/` runs on Node 18+.

## Configure

```bash
export OPENAI_ADS_DEFAULT_ACCOUNT="PRIMARY"   # a label you choose
export OPENAI_ADS_PRIMARY_API_KEY="..."       # OPENAI_ADS_<ACCOUNT>_API_KEY
export OPENAI_ADS_ENABLE_WRITES="0"           # keep writes off until you mean it
```

Each ad account is an uppercase, env-safe **account key**. The server reads its
key from `OPENAI_ADS_<ACCOUNT_KEY>_API_KEY`, so multiple accounts just need
multiple env vars. Tools accept an optional `account_key`; if omitted they fall
back to `OPENAI_ADS_DEFAULT_ACCOUNT`.

### Register with an MCP client

stdio command: `bun /absolute/path/to/openai-ads-mcp/index.ts`
(or `node /absolute/path/to/openai-ads-mcp/dist/index.js` after `bun run build`).

`.mcp.json` / Claude Desktop example:

```json
{
  "mcpServers": {
    "openai-ads": {
      "command": "bun",
      "args": ["/absolute/path/to/openai-ads-mcp/index.ts"],
      "env": {
        "OPENAI_ADS_DEFAULT_ACCOUNT": "PRIMARY",
        "OPENAI_ADS_PRIMARY_API_KEY": "..."
      }
    }
  }
}
```

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

```json
{
  "id": "example-approval",
  "account_key": "PRIMARY",
  "approved_by": "you",
  "approved_at": "2026-06-02T00:00:00.000Z",
  "max_budget_micros": 10000000,
  "approved_countries": ["US"],
  "allow_destructive": false,
  "operations": []
}
```

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
