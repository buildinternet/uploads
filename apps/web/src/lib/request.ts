/** Bounded browser fetches with a machine-readable unavailable outcome. */
export const BROWSER_REQUEST_TIMEOUT_MS = 8_000;

export type RequestFailure = "timeout" | "network";
export type RequestResult =
  | { kind: "response"; response: Response }
  | { kind: "unavailable"; reason: RequestFailure };

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = BROWSER_REQUEST_TIMEOUT_MS,
): Promise<RequestResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return { kind: "response", response };
  } catch (err) {
    return {
      kind: "unavailable",
      reason: err instanceof DOMException && err.name === "AbortError" ? "timeout" : "network",
    };
  } finally {
    clearTimeout(timeout);
  }
}
