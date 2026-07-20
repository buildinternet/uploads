/**
 * Validates the budget-limit patch body accepted by the admin panel's
 * PATCH /admin-ui/workspaces/:name/limits endpoint. Pure — no I/O — so it is
 * unit-tested directly and could back a future token-gated /admin twin.
 *
 * Mirrors set-workspace-limits.mjs's field set and clear semantics, but only
 * the four numeric budget fields (no retention / key-policy). A value is a
 * finite integer >= 1 (set the cap) or null (clear the field -> unlimited).
 */
import { ValidationError } from "@uploads/errors";

export const LIMIT_FIELDS = [
  "maxStorageBytes",
  "maxUploadsPerPeriod",
  "maxUploadBytes",
  "maxVideoUploadBytes",
] as const;

export type LimitField = (typeof LIMIT_FIELDS)[number];

export type LimitsPatch = Partial<Record<LimitField, number | null>>;

export function validateLimitsPatch(body: unknown): LimitsPatch {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("limits body must be a JSON object", { code: "invalid_limit" });
  }
  const record = body as Record<string, unknown>;
  const patch: LimitsPatch = {};
  for (const field of LIMIT_FIELDS) {
    if (!(field in record)) continue;
    const value = record[field];
    if (value === null) {
      patch[field] = null;
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new ValidationError(`${field} must be a positive integer or null`, {
        code: "invalid_limit",
        details: { field },
      });
    }
    patch[field] = value;
  }
  return patch;
}
