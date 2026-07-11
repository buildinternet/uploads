/**
 * Coarse error categories. Each maps to an HTTP status via {@link STATUS_BY_TYPE}.
 * Clients switch on `type` for branching; `code` is the specific discriminant.
 */
export const ERROR_TYPES = [
  "validation",
  "unauthorized",
  "forbidden",
  "insufficient_scope",
  "not_found",
  "method_not_allowed",
  "conflict",
  "payload_too_large",
  "unsupported_media_type",
  "rate_limited",
  "insufficient_storage",
  "unavailable",
  "internal",
] as const;

export type ErrorType = (typeof ERROR_TYPES)[number];

/** category → HTTP status. Status is derived from `type`, never hand-picked on the wire. */
export const STATUS_BY_TYPE: Record<ErrorType, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  insufficient_scope: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  insufficient_storage: 507,
  unavailable: 503,
  internal: 500,
};

export function statusForType(type: ErrorType): number {
  return STATUS_BY_TYPE[type];
}

/**
 * Reverse of {@link STATUS_BY_TYPE}. Shared statuses resolve to the earlier
 * (primary) type in {@link ERROR_TYPES} — 403 → `forbidden`, not `insufficient_scope`.
 */
export const TYPE_BY_STATUS: Record<number, ErrorType> = (() => {
  const map: Record<number, ErrorType> = {};
  for (const type of ERROR_TYPES) {
    const status = STATUS_BY_TYPE[type];
    if (map[status] === undefined) map[status] = type;
  }
  return map;
})();

export function typeForStatus(status: number): ErrorType {
  return TYPE_BY_STATUS[status] ?? "internal";
}

/** Types where retrying the same request later can plausibly succeed. */
const RETRYABLE_TYPES: ReadonlySet<ErrorType> = new Set(["rate_limited", "unavailable"]);

export function isRetryableType(type: ErrorType): boolean {
  return RETRYABLE_TYPES.has(type);
}
