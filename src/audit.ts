import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const SECRETISH = /(authorization|api[_-]?key|token|secret|password)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        SECRETISH.test(key) ? "[REDACTED]" : redact(child),
      ])
    );
  }
  return value;
}

export function payloadHash(payload: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(redact(payload)))
    .digest("hex");
}

export interface AuditEvent {
  agent?: string;
  account_key: string;
  tool: string;
  approval_id?: string;
  entity_ids?: string[];
  status: "success" | "error" | "skipped";
  api_status?: number;
  payload?: unknown;
  message?: string;
}

export async function writeAuditEvent(
  auditLogPath: string,
  event: AuditEvent,
  now = new Date()
) {
  await fs.mkdir(path.dirname(auditLogPath), { recursive: true });
  const entry = {
    ts: now.toISOString(),
    ...redact(event),
    payload_hash: event.payload === undefined ? undefined : payloadHash(event.payload),
    payload: undefined,
  };
  await fs.appendFile(auditLogPath, `${JSON.stringify(entry)}\n`);
}
