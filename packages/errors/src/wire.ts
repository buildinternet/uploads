import { ERROR_TYPES, type ErrorType } from "./types";

/**
 * The single on-the-wire error shape (nested `error`, Stripe-style).
 * `type` is a constrained enum; `code` is an open string for forward-compat.
 */
export type ErrorEnvelope = {
  error: {
    code: string;
    type: ErrorType;
    message: string;
    details?: unknown;
  };
};

export function isErrorType(value: unknown): value is ErrorType {
  return typeof value === "string" && (ERROR_TYPES as readonly string[]).includes(value);
}

/** Structural check for a nested error envelope (no zod — Workers-friendly). */
export function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  if (typeof body !== "object" || body === null || !("error" in body)) return false;
  const err = (body as { error: unknown }).error;
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return typeof e.code === "string" && isErrorType(e.type) && typeof e.message === "string";
}
