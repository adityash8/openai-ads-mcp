import {
  ConversionEventSchema,
  type ConversionEvent,
  type Operation,
} from "./schemas";

export interface InsightRow {
  impressions?: number;
  clicks?: number;
  spend?: number;
  spend_micros?: number;
  ad_id?: string;
  ad_name?: string;
  campaign_id?: string;
  campaign_name?: string;
  [key: string]: unknown;
}

export function draftCampaignBundleOperations(input: {
  campaign: Record<string, unknown>;
  ad_group: Record<string, unknown>;
  ads: Record<string, unknown>[];
}): Operation[] {
  const campaignRef = "{{campaign.id}}";
  const adGroupRef = "{{ad_group.id}}";

  return [
    {
      type: "create_campaign",
      payload: { status: "paused", ...input.campaign },
    },
    {
      type: "create_ad_group",
      payload: {
        status: "paused",
        ...input.ad_group,
        campaign_id:
          typeof input.ad_group.campaign_id === "string"
            ? input.ad_group.campaign_id
            : campaignRef,
      },
    },
    ...input.ads.map((ad) => ({
      type: "create_ad" as const,
      payload: {
        status: "paused",
        ...ad,
        ad_group_id:
          typeof ad.ad_group_id === "string" ? ad.ad_group_id : adGroupRef,
      },
    })),
  ];
}

export function summarizeInsights(raw: unknown) {
  const rows = extractInsightRows(raw);
  const totals = rows.reduce(
    (acc, row) => {
      const impressions = toNumber(row.impressions);
      const clicks = toNumber(row.clicks);
      const spendMicros = toNumber(row.spend_micros);
      const spend = spendMicros > 0 ? spendMicros / 1_000_000 : toNumber(row.spend);
      acc.impressions += impressions;
      acc.clicks += clicks;
      acc.spend += spend;
      return acc;
    },
    { impressions: 0, clicks: 0, spend: 0 }
  );

  const ctr = totals.impressions > 0 ? totals.clicks / totals.impressions : 0;
  const cpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;
  const cpm = totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0;

  const recommendations = buildRecommendations({ ...totals, ctr, cpc, cpm }, rows);

  return {
    totals: {
      impressions: totals.impressions,
      clicks: totals.clicks,
      spend: roundCurrency(totals.spend),
      ctr: roundRate(ctr),
      cpc: roundCurrency(cpc),
      cpm: roundCurrency(cpm),
    },
    rows_analyzed: rows.length,
    recommendations,
  };
}

export function validateConversionEvent(event: ConversionEvent, now = Date.now()) {
  const parsed = ConversionEventSchema.parse(event);
  const timestamp = parsed.timestamp_ms ?? now;
  const ageMs = now - timestamp;
  const futureMs = timestamp - now;
  const warnings: string[] = [];
  const errors: string[] = [];

  if (ageMs > 7 * 24 * 60 * 60 * 1000) {
    errors.push("timestamp_ms must be within the last 7 days for Conversions API events.");
  }
  if (futureMs > 10 * 60 * 1000) {
    errors.push("timestamp_ms cannot be more than 10 minutes in the future.");
  }
  if (!parsed.id) {
    warnings.push("Missing event id; deduplication between Pixel and CAPI is weaker.");
  }
  if (parsed.type === "custom") {
    warnings.push("custom events are valid but less standardized for reporting than supported funnel events.");
  }

  return {
    ok: errors.length === 0,
    event: { ...parsed, timestamp_ms: timestamp },
    errors,
    warnings,
  };
}

function extractInsightRows(raw: unknown): InsightRow[] {
  if (Array.isArray(raw)) return raw as InsightRow[];
  if (!raw || typeof raw !== "object") return [];
  const object = raw as Record<string, unknown>;
  for (const key of ["data", "results", "rows", "insights"]) {
    if (Array.isArray(object[key])) return object[key] as InsightRow[];
  }
  return [object as InsightRow];
}

function buildRecommendations(
  totals: { impressions: number; clicks: number; spend: number; ctr: number; cpc: number; cpm: number },
  rows: InsightRow[]
) {
  const recommendations: string[] = [];

  if (totals.impressions < 1000) {
    recommendations.push("Collect more delivery before making budget or creative calls.");
    return recommendations;
  }
  if (totals.ctr < 0.005) {
    recommendations.push("CTR is below 0.5%; draft new hooks and clearer chat-card value props.");
  }
  if (totals.clicks >= 50 && totals.spend > 0) {
    recommendations.push("Enough click data exists for landing-page and conversion-path review.");
  }

  const weakRows = rows.filter((row) => toNumber(row.impressions) >= 500 && toNumber(row.clicks) === 0);
  if (weakRows.length > 0) {
    recommendations.push("Pause or rewrite ads/ad groups with 500+ impressions and zero clicks.");
  }

  if (recommendations.length === 0) {
    recommendations.push("No urgent optimization flags; keep monitoring spend, CTR, CPC, and review status.");
  }

  return recommendations;
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function roundRate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}
