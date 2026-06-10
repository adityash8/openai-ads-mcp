import crypto from "node:crypto";
import type { ApprovalArtifact, Operation } from "./schemas";

export interface GuardrailCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function collectBudgetMicros(value: unknown): number[] {
  const budgets: number[] = [];

  function visit(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (
        typeof child === "number" &&
        Number.isFinite(child) &&
        key.toLowerCase().includes("budget") &&
        key.toLowerCase().includes("micros")
      ) {
        budgets.push(child);
      }
      visit(child);
    }
  }

  visit(value);
  return budgets;
}

export function collectCountries(value: unknown): string[] {
  const countries = new Set<string>();

  function visit(node: unknown) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (typeof item === "string" && /^[A-Z]{2}$/.test(item)) {
          countries.add(item);
        } else {
          visit(item);
        }
      }
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (key.toLowerCase().includes("countr")) {
        if (Array.isArray(child)) {
          for (const country of child) {
            if (typeof country === "string") countries.add(country.toUpperCase());
          }
        } else if (typeof child === "string") {
          countries.add(child.toUpperCase());
        }
      }
      visit(child);
    }
  }

  visit(value);
  return [...countries];
}

export function operationHash(operations: Operation[]): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(operations))
    .digest("hex");
}

export function checkApprovedOperations(options: {
  writeEnabled: boolean;
  requestedAccountKey: string;
  approval: ApprovalArtifact;
  operations: Operation[];
}): GuardrailCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!options.writeEnabled) {
    errors.push("Writes are disabled. Set OPENAI_ADS_ENABLE_WRITES=1 for approved live mutations.");
  }

  if (options.approval.account_key !== options.requestedAccountKey) {
    errors.push(
      `Approval account_key ${options.approval.account_key} does not match requested account ${options.requestedAccountKey}.`
    );
  }

  if (operationHash(options.approval.operations) !== operationHash(options.operations)) {
    errors.push("Approval operations do not match the requested operations.");
  }

  const destructive = options.operations.filter((operation) => {
    return "action" in operation && operation.action === "archive";
  });
  if (destructive.length > 0 && !options.approval.allow_destructive) {
    errors.push("Archive operations require approval.allow_destructive=true.");
  }

  if (options.approval.max_budget_micros !== undefined) {
    const budgets = collectBudgetMicros(options.operations);
    const overBudget = budgets.filter(
      (budget) => budget > options.approval.max_budget_micros!
    );
    if (overBudget.length > 0) {
      errors.push(
        `Operation budget exceeds approval max_budget_micros=${options.approval.max_budget_micros}.`
      );
    }
  } else {
    warnings.push("Approval has no max_budget_micros guardrail.");
  }

  if (options.approval.approved_countries?.length) {
    const allowed = new Set(options.approval.approved_countries.map((country) => country.toUpperCase()));
    const countries = collectCountries(options.operations);
    const disallowed = countries.filter((country) => !allowed.has(country.toUpperCase()));
    if (disallowed.length > 0) {
      errors.push(`Operation targets unapproved countries: ${disallowed.join(", ")}.`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

export function assertGuardrailCheck(check: GuardrailCheck) {
  if (!check.ok) {
    throw new Error(check.errors.join(" "));
  }
}
