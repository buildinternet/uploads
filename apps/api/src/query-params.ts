import { ValidationError } from "@uploads/errors";

/** `?limit=`: `fallback` when absent, else an integer in `1..max` or a 400 `invalid_limit`. */
export function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new ValidationError(`limit must be an integer between 1 and ${max}.`, {
      code: "invalid_limit",
    });
  }
  return limit;
}
