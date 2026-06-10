import fs from "node:fs/promises";
import path from "node:path";

export interface AdsClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class AdsApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "AdsApiError";
    this.status = status;
    this.body = body;
  }
}

export class AdsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AdsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  getAccount() {
    return this.request("GET", "/ad_account");
  }

  listCampaigns(query: Record<string, unknown> = {}) {
    return this.request("GET", "/campaigns", undefined, query);
  }

  createCampaign(payload: unknown) {
    return this.request("POST", "/campaigns", payload);
  }

  updateCampaign(id: string, payload: unknown) {
    return this.request("POST", `/campaigns/${encodeURIComponent(id)}`, payload);
  }

  campaignState(id: string, action: string) {
    return this.request(
      "POST",
      `/campaigns/${encodeURIComponent(id)}/${encodeURIComponent(action)}`
    );
  }

  listAdGroups(query: Record<string, unknown> = {}) {
    return this.request("GET", "/ad_groups", undefined, query);
  }

  createAdGroup(payload: unknown) {
    return this.request("POST", "/ad_groups", payload);
  }

  updateAdGroup(id: string, payload: unknown) {
    return this.request("POST", `/ad_groups/${encodeURIComponent(id)}`, payload);
  }

  adGroupState(id: string, action: string) {
    return this.request(
      "POST",
      `/ad_groups/${encodeURIComponent(id)}/${encodeURIComponent(action)}`
    );
  }

  listAds(query: Record<string, unknown> = {}) {
    return this.request("GET", "/ads", undefined, query);
  }

  createAd(payload: unknown) {
    return this.request("POST", "/ads", payload);
  }

  updateAd(id: string, payload: unknown) {
    return this.request("POST", `/ads/${encodeURIComponent(id)}`, payload);
  }

  adState(id: string, action: string) {
    return this.request(
      "POST",
      `/ads/${encodeURIComponent(id)}/${encodeURIComponent(action)}`
    );
  }

  getInsights(level: "account" | "campaign" | "ad_group" | "ad", query: Record<string, unknown>) {
    const id = typeof query.id === "string" ? query.id : undefined;
    const cleanQuery = { ...query };
    delete cleanQuery.id;
    delete cleanQuery.account_key;
    delete cleanQuery.level;

    if (!cleanQuery.time_granularity && cleanQuery.granularity) {
      cleanQuery.time_granularity = cleanQuery.granularity;
    }
    delete cleanQuery.granularity;
    if (typeof cleanQuery.time_granularity === "string") {
      cleanQuery.time_granularity = normalizeTimeGranularity(cleanQuery.time_granularity);
    }

    if (level === "account") {
      return this.request("GET", "/ad_account/insights", undefined, cleanQuery);
    }

    if (!id) {
      throw new Error(`id is required for ${level} insights`);
    }

    const collection =
      level === "campaign" ? "campaigns" : level === "ad_group" ? "ad_groups" : "ads";
    return this.request(
      "GET",
      `/${collection}/${encodeURIComponent(id)}/insights`,
      undefined,
      cleanQuery
    );
  }

  async uploadImage(filePath: string, purpose: string) {
    const bytes = await fs.readFile(filePath);
    const formData = new FormData();
    formData.set(
      "file",
      new Blob([bytes]),
      path.basename(filePath)
    );
    formData.set("purpose", purpose);
    return this.requestForm("POST", "/upload", formData);
  }

  private async request(
    method: string,
    route: string,
    body?: unknown,
    query: Record<string, unknown> = {}
  ) {
    const url = this.url(route, query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(url, init);
    return this.parseResponse(response);
  }

  private async requestForm(method: string, route: string, body: FormData) {
    const response = await this.fetchImpl(this.url(route), {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      },
      body,
    });
    return this.parseResponse(response);
  }

  private url(route: string, query: Record<string, unknown> = {}) {
    const url = new URL(this.baseUrl + route);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item === undefined || item === null || item === "") continue;
          url.searchParams.append(`${key}[]`, String(item));
        }
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async parseResponse(response: Response) {
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await response.json().catch(() => undefined)
      : await response.text().catch(() => undefined);

    if (!response.ok) {
      throw new AdsApiError(
        `OpenAI Ads API request failed with HTTP ${response.status}`,
        response.status,
        body
      );
    }

    return body;
  }
}

function normalizeTimeGranularity(value: string) {
  if (value === "day") return "daily";
  if (value === "all") return "none";
  return value;
}
