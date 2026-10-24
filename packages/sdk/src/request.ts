import { UploadsError } from "./errors.js";

// Bare `fetch` has no timeout (undici waits ~5 minutes for headers), so a
// backend stall would hang the caller. Every API call goes through
// `resilientFetch` for a bounded timeout and one bounded retry. File `put`
// gets a longer timeout than JSON calls.
export const JSON_TIMEOUT_MS = 15_000;
export const CONTENT_TIMEOUT_MS = 60_000;

// At most one retry, on network errors, 503 and 429. GET always; POST/PUT
// only with an Idempotency-Key (a bare PUT to a strict key can 409 on
// replay). DELETE/PATCH never: "no bytes sent" vs "already applied" isn't
// reliably distinguishable.
const MAX_ATTEMPTS = 2;
const RETRYABLE_METHODS = new Set(["GET"]);
const IDEMPOTENCY_KEYED_METHODS = new Set(["POST", "PUT"]);
const RETRYABLE_STATUSES = new Set([429, 503]);
const DEFAULT_RETRY_DELAY_MS = 2_000;
// Cap an honored X-Retry-After so it can't stall a hook or CI step.
const MAX_RETRY_AFTER_DELAY_MS = 10_000;

/** Why a request is about to be retried, for logging. */
export interface RetryInfo {
  /** `responded 503`, or `request failed` for a network error. */
  reason: string;
  delayMs: number;
}

export interface TransportOptions {
  /** Replaces the global `fetch`, e.g. to add logging or run in tests. */
  fetch?: typeof fetch;
  /** Called before the one automatic retry. */
  onRetry?: (info: RetryInfo) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Seconds-valued retry delay from the response, capped; falls back to the default backoff. */
function retryDelayMs(res: Response | undefined): number {
  const raw = res?.headers.get("x-retry-after") ?? res?.headers.get("retry-after");
  const seconds = raw ? Number(raw) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_DELAY_MS);
  }
  return DEFAULT_RETRY_DELAY_MS;
}

/**
 * fetch with a timeout. Any rejection surfaces as `UploadsError` `NETWORK`,
 * naming the timeout.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch | undefined,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await (fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new UploadsError(`request timed out after ${timeoutMs}ms`, "NETWORK");
    }
    throw new UploadsError(
      err instanceof Error ? err.message : "network request failed",
      "NETWORK",
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Timeout plus one retry on network errors, 503 and 429, honoring
 * `X-Retry-After`. Never retries a non-idempotent request. Returns the final
 * raw `Response`; callers handle `!res.ok`.
 */
export async function resilientFetch(
  method: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  transport: TransportOptions = {},
): Promise<Response> {
  const normalizedMethod = method.toUpperCase();
  const retryable =
    RETRYABLE_METHODS.has(normalizedMethod) ||
    (IDEMPOTENCY_KEYED_METHODS.has(normalizedMethod) &&
      new Headers(init.headers).has("Idempotency-Key"));
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    let networkErr: UploadsError | undefined;
    try {
      res = await fetchWithTimeout(url, init, timeoutMs, transport.fetch);
    } catch (err) {
      networkErr = err as UploadsError;
    }

    const canRetry =
      retryable &&
      attempt < MAX_ATTEMPTS &&
      (networkErr !== undefined || (res !== undefined && RETRYABLE_STATUSES.has(res.status)));

    if (!canRetry) {
      if (networkErr) throw networkErr;
      return res as Response;
    }

    const delayMs = retryDelayMs(res);
    transport.onRetry?.({
      reason: res ? `responded ${res.status}` : "request failed",
      delayMs,
    });
    await sleep(delayMs);
  }
}

/** Where to get a missing file scope. Same sentence as the API 403. */
export function scopeRemedy(scope: string): string {
  return `Ask a workspace admin, or mint a token with ${scope} at https://uploads.sh/account/developers.`;
}

export function mapApiError(
  status: number,
  error: string,
  code?: string,
  requiredScope?: string,
  existingUrl?: string,
): UploadsError {
  const normalized = error.toLowerCase();
  if (status === 401 || code === "unauthorized" || normalized === "unauthorized") {
    return new UploadsError(error, "UNAUTHORIZED", status);
  }
  if (code === "insufficient_scope") {
    // Rebuilt from `required_scope` so older servers' bare "forbidden" is
    // actionable too.
    const message = requiredScope
      ? `token lacks the ${requiredScope} scope. ${scopeRemedy(requiredScope)}`
      : error;
    return new UploadsError(message, "INSUFFICIENT_SCOPE", status, { requiredScope });
  }
  if (status === 404 || code === "not_found" || normalized === "not found") {
    return new UploadsError(error, "NOT_FOUND", status);
  }
  if (code === "invalid_key" || (status === 400 && normalized === "invalid key")) {
    return new UploadsError(error, "INVALID_KEY", status);
  }
  if (code === "key_prefix_not_allowed" || code === "key_too_deep") {
    return new UploadsError(error, "KEY_POLICY", status);
  }
  // Prefer stable body code — bare 429 is also used for write rate limits.
  if (status === 507 || code === "storage_quota_exceeded") {
    return new UploadsError(error, "STORAGE_QUOTA", status);
  }
  if (code === "upload_budget_exceeded") {
    return new UploadsError(error, "UPLOAD_BUDGET", status);
  }
  if (code === "github_required") {
    return new UploadsError(error, "GITHUB_REQUIRED", status);
  }
  if (code === "key_exists") {
    return new UploadsError(error, "KEY_EXISTS", status, { existingUrl });
  }
  return new UploadsError(error, "API_ERROR", status);
}

/**
 * Parse API error bodies: the nested `{ error: { code, type, message,
 * details? } }` envelope, or the legacy flat `{ error, code? }`.
 */
export function extractErrorFields(
  body: unknown,
  fallback = "request failed",
): { message: string; code?: string; requiredScope?: string; existingUrl?: string } {
  if (typeof body === "object" && body && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === "object" && err && "message" in err) {
      const nested = err as { message?: unknown; code?: unknown; details?: unknown };
      const details = nested.details as { required_scope?: unknown; url?: unknown } | undefined;
      return {
        message: typeof nested.message === "string" ? nested.message : fallback,
        code: typeof nested.code === "string" ? nested.code : undefined,
        ...(typeof details?.required_scope === "string"
          ? { requiredScope: details.required_scope }
          : {}),
        ...(typeof details?.url === "string" ? { existingUrl: details.url } : {}),
      };
    }
    if (typeof err === "string") {
      const code =
        "code" in body && typeof (body as { code: unknown }).code === "string"
          ? (body as { code: string }).code
          : undefined;
      return { message: err, code };
    }
  }
  return { message: fallback };
}

/** Fetch + parse an error-response body via {@link extractErrorFields}. */
export async function parseErrorEnvelope(
  res: Response,
  fallback = "request failed",
): Promise<{ message: string; code?: string; requiredScope?: string; existingUrl?: string }> {
  const body = await res.json().catch(() => ({}));
  return extractErrorFields(body, fallback);
}

export async function parseErrorResponse(res: Response): Promise<UploadsError> {
  const { message, code, requiredScope, existingUrl } = await parseErrorEnvelope(
    res,
    res.statusText || "request failed",
  );
  return mapApiError(res.status, message, code, requiredScope, existingUrl);
}

/**
 * One JSON request with the client's timeout, retry and error mapping, for
 * endpoints the client has no method for. Throws `UploadsError` on a non-2xx.
 */
export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  transport: TransportOptions = {},
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const res = await resilientFetch(method, url, init, JSON_TIMEOUT_MS, transport);
  if (!res.ok) throw await parseErrorResponse(res);
  return (await res.json()) as T;
}
