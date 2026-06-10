import { z } from "zod";

export const DEFAULT_BASE_URL = "https://api.ads.openai.com/v1";
export const DEFAULT_APPROVAL_DIR = "tasks/openai-ads/approvals";
export const DEFAULT_AUDIT_LOG = "tasks/openai-ads/audit.jsonl";

export const AccountKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "account_key must be an uppercase env-safe key")
  .default("PRIMARY");

export const PaginationSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  after: z.string().min(1).optional(),
  before: z.string().min(1).optional(),
});

export const EntityStateSchema = z.enum(["draft", "active", "paused", "archived"]);
export const StateActionSchema = z.enum(["activate", "pause", "archive"]);

export const CampaignPayloadSchema = z
  .object({
    name: z.string().min(1),
    objective: z.string().min(1).optional(),
    status: EntityStateSchema.optional(),
    start_time: z.string().optional(),
    end_time: z.string().optional(),
    countries: z.array(z.string().length(2)).min(1).optional(),
    daily_budget_micros: z.number().int().nonnegative().optional(),
    lifetime_budget_micros: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const AdGroupPayloadSchema = z
  .object({
    campaign_id: z.string().min(1).optional(),
    name: z.string().min(1),
    status: EntityStateSchema.optional(),
    billing_event_type: z.string().min(1).optional(),
    bid_amount_micros: z.number().int().nonnegative().optional(),
    daily_budget_micros: z.number().int().nonnegative().optional(),
    targeting: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const ChatCardCreativeSchema = z
  .object({
    type: z.literal("chat_card").default("chat_card"),
    title: z.string().min(3).max(50),
    body: z.string().min(1).max(100),
    target_url: z.string().url(),
    file_id: z.string().min(1),
  })
  .passthrough();

export const AdPayloadSchema = z
  .object({
    ad_group_id: z.string().min(1).optional(),
    name: z.string().min(1),
    status: EntityStateSchema.optional(),
    creative: ChatCardCreativeSchema,
  })
  .passthrough();

export const CampaignBundleSchema = z.object({
  account_key: AccountKeySchema.optional(),
  campaign: CampaignPayloadSchema,
  ad_group: AdGroupPayloadSchema,
  ads: z.array(AdPayloadSchema).min(1).max(20),
});

export type CampaignBundle = z.infer<typeof CampaignBundleSchema>;

export const OperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_campaign"),
    payload: CampaignPayloadSchema,
  }),
  z.object({
    type: z.literal("update_campaign"),
    id: z.string().min(1),
    payload: CampaignPayloadSchema.partial().passthrough(),
  }),
  z.object({
    type: z.literal("campaign_state"),
    id: z.string().min(1),
    action: StateActionSchema,
  }),
  z.object({
    type: z.literal("create_ad_group"),
    payload: AdGroupPayloadSchema.extend({
      campaign_id: z.string().min(1),
    }),
  }),
  z.object({
    type: z.literal("update_ad_group"),
    id: z.string().min(1),
    payload: AdGroupPayloadSchema.partial().passthrough(),
  }),
  z.object({
    type: z.literal("ad_group_state"),
    id: z.string().min(1),
    action: StateActionSchema,
  }),
  z.object({
    type: z.literal("create_ad"),
    payload: AdPayloadSchema.extend({
      ad_group_id: z.string().min(1),
    }),
  }),
  z.object({
    type: z.literal("update_ad"),
    id: z.string().min(1),
    payload: AdPayloadSchema.partial().passthrough(),
  }),
  z.object({
    type: z.literal("ad_state"),
    id: z.string().min(1),
    action: StateActionSchema,
  }),
]);

export type Operation = z.infer<typeof OperationSchema>;

export const ApprovalArtifactSchema = z.object({
  id: z.string().min(1),
  account_key: AccountKeySchema,
  approved_by: z.string().min(1),
  approved_at: z.string().datetime(),
  max_budget_micros: z.number().int().nonnegative().optional(),
  approved_countries: z.array(z.string().length(2)).optional(),
  allow_destructive: z.boolean().default(false),
  operations: z.array(OperationSchema).min(1),
  notes: z.string().optional(),
});

export type ApprovalArtifact = z.infer<typeof ApprovalArtifactSchema>;

export const InsightsLevelSchema = z.enum(["account", "campaign", "ad_group", "ad"]);
export const TimeGranularitySchema = z.enum(["daily", "none", "day", "all"]);

export const InsightsQuerySchema = z
  .object({
    account_key: AccountKeySchema.optional(),
    level: InsightsLevelSchema.default("account"),
    id: z.string().min(1).optional(),
    date_from: z.string().optional(),
    date_to: z.string().optional(),
    granularity: TimeGranularitySchema.optional(),
    time_granularity: TimeGranularitySchema.optional(),
    aggregation_level: z.string().optional(),
    fields: z.array(z.string().min(1)).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .passthrough();

export type InsightsQuery = z.infer<typeof InsightsQuerySchema>;

export const SupportedConversionEventSchema = z.enum([
  "appointment_scheduled",
  "checkout_started",
  "contents_viewed",
  "custom",
  "items_added",
  "lead_created",
  "order_created",
  "page_viewed",
  "registration_completed",
  "subscription_created",
  "trial_started",
]);

export const ConversionEventSchema = z.object({
  id: z.string().min(1).optional(),
  type: SupportedConversionEventSchema,
  timestamp_ms: z.number().int().optional(),
  data: z.record(z.unknown()).default({}),
  metadata: z.record(z.unknown()).optional(),
});

export type ConversionEvent = z.infer<typeof ConversionEventSchema>;

export const ApplyApprovedPlanSchema = z.object({
  account_key: AccountKeySchema.optional(),
  approval_id: z.string().min(1),
  operations: z.array(OperationSchema).optional(),
});

export const UploadImageSchema = z.object({
  account_key: AccountKeySchema.optional(),
  file_path: z.string().min(1),
  purpose: z.string().default("ad"),
});

export const DraftAdUpdateSchema = z.object({
  account_key: AccountKeySchema.optional(),
  ad_id: z.string().min(1),
  payload: AdPayloadSchema.partial().passthrough(),
});

export const ListCampaignsSchema = PaginationSchema.extend({
  account_key: AccountKeySchema.optional(),
  status: EntityStateSchema.optional(),
}).passthrough();

export const ListAdGroupsSchema = PaginationSchema.extend({
  account_key: AccountKeySchema.optional(),
  campaign_id: z.string().min(1).optional(),
  status: EntityStateSchema.optional(),
}).passthrough();

export const ListAdsSchema = PaginationSchema.extend({
  account_key: AccountKeySchema.optional(),
  ad_group_id: z.string().min(1).optional(),
  status: EntityStateSchema.optional(),
}).passthrough();
