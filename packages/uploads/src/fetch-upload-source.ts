/**
 * Fetch bytes from a caller-supplied URL for `put --url` / MCP `contentUrl`.
 *
 * Guardrails: HTTPS only (http allowed on loopback when `allowLoopback` is
 * set), no URL credentials, private/internal hosts rejected unless they are
 * loopback and `allowLoopback` is set. Redirects re-checked each hop; a
 * public origin cannot redirect onto loopback. No auth headers forwarded.
 * The server still sniffs and size-caps after this.
 */
import { UploadsError, type UploadsErrorCode } from "./errors.js";
import { isLoopbackHost, isPrivateOrLocalHost } from "./private-host.js";

export const FETCH_UPLOAD_SOURCE_TIMEOUT_MS = 15_000;
export const FETCH_UPLOAD_SOURCE_MAX_REDIRECTS = 5;
/** Client-side cap when the caller does not pass a workspace policy ceiling. */
export const FETCH_UPLOAD_SOURCE_DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchableUploadUrlOptions {
  /**
   * CLI / stdio MCP only. Permit loopback (`localhost`, `*.localhost`,
   * `127.0.0.0/8`, `::1`) and `http` on those hosts. LAN, link-local, and
   * `.internal` stay rejected. Hosted MCP must not set this.
   */
  allowLoopback?: boolean;
}

export interface FetchUploadSourceOptions extends FetchableUploadUrlOptions {
  maxBytes?: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Human label in errors (`--url`, `contentUrl`). */
  label?: string;
  userAgent?: string;
}

function fail(label: string, message: string, code: UploadsErrorCode = "USAGE"): never {
  throw new UploadsError(`${label} ${message}`, code);
}

/** Parse and reject URLs we will not fetch. Used on the original URL and every redirect. */
export function assertFetchableUploadUrl(
  raw: string,
  label = "url",
  opts: FetchableUploadUrlOptions = {},
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(label, "must be a valid absolute URL");
  }
  const loopback = isLoopbackHost(url.hostname);
  const allowThisLoopback = Boolean(opts.allowLoopback && loopback);
  if (url.protocol === "http:") {
    if (!allowThisLoopback) fail(label, "must be https");
  } else if (url.protocol !== "https:") {
    fail(label, "must be https");
  }
  if (url.username !== "" || url.password !== "") {
    fail(label, "must not include credentials");
  }
  if (isPrivateOrLocalHost(url.hostname) && !allowThisLoopback) {
    fail(label, "targets a private or internal network");
  }
  return url;
}

/** Filename leaf from a URL path (`https://cdn.example/a/shot.png?x=1` → `shot.png`). */
export function filenameFromUploadUrl(url: URL): string | undefined {
  const last = url.pathname.replace(/\/+$/, "").split("/").pop();
  if (!last) return undefined;
  let decoded = last;
  try {
    decoded = decodeURIComponent(last);
  } catch {
    // Keep the raw segment.
  }
  const cleaned = decoded.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || undefined;
}

/** `filename` if given, else the URL path leaf. Throws USAGE when neither works. */
export function resolveUploadFilename(
  rawUrl: string,
  filename: string | undefined,
  label = "url",
  opts: FetchableUploadUrlOptions = {},
): string {
  if (filename) return filename;
  const derived = filenameFromUploadUrl(assertFetchableUploadUrl(rawUrl, label, opts));
  if (!derived) {
    throw new UploadsError(`${label} has no filename in the path; pass a filename`, "USAGE");
  }
  return derived;
}

function timeoutError(label: string): never {
  fail(label, "fetch timed out", "NETWORK");
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

async function readCappedBody(res: Response, maxBytes: number, label: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    fail(label, `exceeds the upload limit (${maxBytes} bytes)`);
  }

  const body = res.body;
  if (!body) fail(label, "returned an empty body");

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        fail(label, `exceeds the upload limit (${maxBytes} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already locked/cancelled after a size abort.
    }
  }

  if (total === 0) fail(label, "returned an empty body");
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * GET `url` and return the body bytes, capped at `maxBytes`.
 *
 * Redirects are followed manually so each hop is re-validated (scheme, no
 * credentials, host policy). A public origin cannot redirect onto loopback
 * even when `allowLoopback` is set. Auth headers are never forwarded.
 */
export async function fetchUploadSource(
  raw: string,
  opts: FetchUploadSourceOptions = {},
): Promise<Uint8Array> {
  const label = opts.label ?? "url";
  const timeoutMs = opts.timeoutMs ?? FETCH_UPLOAD_SOURCE_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? FETCH_UPLOAD_SOURCE_DEFAULT_MAX_BYTES;
  const doFetch = opts.fetch ?? fetch;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const urlOpts: FetchableUploadUrlOptions = { allowLoopback: opts.allowLoopback };

  let url = assertFetchableUploadUrl(raw, label, urlOpts);

  for (let hop = 0; hop <= FETCH_UPLOAD_SOURCE_MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          accept: "*/*",
          "user-agent": opts.userAgent ?? "uploads.sh",
        },
      });
    } catch (err) {
      if (isAbortError(err) || timeout.aborted) timeoutError(label);
      throw new UploadsError(`could not fetch ${label}`, "NETWORK");
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get("location");
      if (!location) fail(label, "redirect is missing a Location header");
      if (hop === FETCH_UPLOAD_SOURCE_MAX_REDIRECTS) {
        fail(label, "redirected too many times");
      }
      // Loopback is only sticky while we are already on loopback. A public
      // CDN cannot bounce the CLI onto http://127.0.0.1.
      url = assertFetchableUploadUrl(new URL(location, url).toString(), label, {
        allowLoopback: urlOpts.allowLoopback && isLoopbackHost(url.hostname),
      });
      continue;
    }

    if (res.status !== 200) {
      throw new UploadsError(`could not fetch ${label} (HTTP ${res.status})`, "NETWORK");
    }

    try {
      return await readCappedBody(res, maxBytes, label);
    } catch (err) {
      if (isAbortError(err) || timeout.aborted) timeoutError(label);
      throw err;
    }
  }

  fail(label, "redirected too many times");
}
