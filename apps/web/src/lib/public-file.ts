import { CF_RUM_CONNECT_SRC, CF_RUM_SCRIPT_SRC, STYLE_SRC_SELF_AND_INLINE } from "./csp";

// Client model for the standalone public file page (issue #135). Fetched
// server-side from the API's `GET /public/files/:workspace/:key` — apps/web has
// no storage bindings, so the API endpoint is the single-object security
// surface. This mirrors public-gallery.ts, minus collection/ordering concerns.

/** GitHub PR/issue an object is attached to, derived server-side from `gh.*` metadata. */
export interface GithubContext {
  repo: string;
  kind: "pull" | "issue";
  number: number;
  url: string;
}

/** Allowlisted metadata for one public object, as returned by the API. */
export interface PublicFile {
  workspace: string;
  key: string;
  url: string;
  /** Embed-host URL when the dual-host policy applies (GitHub Camo); null otherwise. */
  embedUrl: string | null;
  size: number;
  contentType: string;
  uploaded: string | null;
  /** Queryable `gh.*`-and-other custom metadata pairs; omitted when there are none. */
  metadata?: Record<string, string>;
  /** Convenience view of `gh.repo`/`gh.kind`/`gh.number`, when all three are present and valid. */
  github?: GithubContext;
}

/** Result of resolving a public file: the DTO, a hard 404, a private gate, or a soft outage. */
export type FileFetchResult =
  | { status: "ok"; file: PublicFile }
  | { status: "not_found" }
  | { status: "auth_required" }
  | { status: "unavailable" };

/** How a file should be presented in the page's media stage. */
export type MediaKind = "image" | "video" | "file" | "unsupported";

const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const videoTypes = new Set(["video/mp4", "video/webm"]);

/** Classify a content type for rendering; SVG is unsupported per upload policy. */
export function fileKind(contentType: string): MediaKind {
  if (imageTypes.has(contentType)) return "image";
  if (videoTypes.has(contentType)) return "video";
  if (contentType === "image/svg+xml") return "unsupported";
  return "file";
}

/** A workspace name as it appears in registry keys / public URLs. */
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Reject empty, over-long, traversal, or absolute keys before they reach the API. */
export function isSafeKey(key: string): boolean {
  if (key.length === 0 || key.length > 1024) return false;
  if (key.startsWith("/")) return false;
  return key.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Encode each path segment so filenames with spaces / `#` / `%` round-trip. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/** Build the on-site page path (`/f/<workspace>/<key>`) with each segment encoded. */
export function filePath(workspace: string, key: string): string {
  return `/f/${encodeURIComponent(workspace)}/${encodeKey(key)}`;
}

/**
 * Build the API's forced-download URL (absolute) for a public file — Task 3's
 * `?download=1` query flag on `GET /public/files/:workspace/:key`, *not* a
 * `/download` suffix route. A static suffix after the greedy `:key{.+}` route
 * param is ambiguous (`.../screenshots/download` could mean the suffix or an
 * object literally named `screenshots/download`); the query flag sidesteps
 * that, mirroring the existing `?metadata=1` precedent.
 */
export function fileDownloadUrl(origin: string, workspace: string, key: string): string {
  const url = new URL(`/public/files/${encodeURIComponent(workspace)}/${encodeKey(key)}`, origin);
  url.searchParams.set("download", "1");
  return url.href;
}

/**
 * Shared directives behind both {@link PUBLIC_FILE_CSP} and
 * {@link authRequiredFileCsp} — locked down except for self-hosted
 * styles/fonts and the Cloudflare RUM beacon. `scriptSrc`/`connectSrc`
 * override the default (script-free) posture for the auth-required branch.
 */
function buildFileCsp(overrides?: { scriptSrc?: string; connectSrc?: string }): string {
  return [
    "default-src 'none'",
    "img-src https: data:",
    "media-src https:",
    "font-src 'self'",
    `style-src ${STYLE_SRC_SELF_AND_INLINE}`,
    `script-src ${overrides?.scriptSrc ?? CF_RUM_SCRIPT_SRC}`,
    `connect-src ${overrides?.connectSrc ?? CF_RUM_CONNECT_SRC}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

/**
 * Public file page CSP — same posture as the public gallery: locked down
 * except for self-hosted styles/fonts, the Cloudflare RUM beacon, and (as of
 * the file-page-polish work) inline script for the click-to-copy button and
 * "Copy as" control. `connect-src` stays untouched — clipboard writes never
 * hit the network, and the download link needs no script at all.
 */
export const PUBLIC_FILE_CSP = buildFileCsp({
  scriptSrc: `'self' 'unsafe-inline' ${CF_RUM_SCRIPT_SRC}`,
});

/**
 * CSP for the `auth_required` branch only: same posture as {@link PUBLIC_FILE_CSP}
 * plus `'self' 'unsafe-inline'` script-src (Astro-processed inline `<script>`,
 * same allowance as the signed-in shells — see `signed-in-page.ts`) and
 * `connect-src` widened to the API origin, so the progressive-enhancement
 * script can probe `/me/workspaces/:workspace/file-url`. The normal public
 * branch keeps the strict, script-free policy.
 */
export function authRequiredFileCsp(apiOrigin: string): string {
  return buildFileCsp({
    scriptSrc: `'self' 'unsafe-inline' ${CF_RUM_SCRIPT_SRC}`,
    connectSrc: `${apiOrigin} ${CF_RUM_CONNECT_SRC}`,
  });
}

/**
 * Strict CSP, noindex, no-store — matches the public gallery pages. Pass a
 * `csp` override (e.g. {@link authRequiredFileCsp}) for the auth-required
 * branch, which needs script execution and API connectivity.
 */
export function applyPublicFileHeaders(headers: Headers, options?: { csp?: string }): void {
  headers.set("Content-Security-Policy", options?.csp ?? PUBLIC_FILE_CSP);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Cache-Control", "no-store");
}

/** Bounded plain text: a string within `max` chars and free of control/format code points. */
function text(value: unknown, max: number): value is string {
  if (typeof value !== "string" || value.length > max) return false;
  return Array.from(value).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) return true;
    if (code < 32 || code === 127 || (code >= 0x80 && code <= 0x9f)) return false;
    return !/\p{Cf}/u.test(character);
  });
}

/** A bounded, well-formed `https:` URL — the only scheme the page will render/link. */
function httpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** `httpsUrl`, but also accepts `null` — for optional-but-typed URL fields like `embedUrl`. */
function nullableHttpsUrl(value: unknown): value is string | null {
  return value === null || httpsUrl(value);
}

/**
 * Validate a 401 error body against the bounded shape the API commits to
 * (issue #139 Task A): `{"error":{"code":"auth_required","message":"..."}}`.
 * Any other shape — or any other `code` — is treated as a malformed 401.
 */
function isAuthRequiredError(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  if (typeof body.error !== "object" || body.error === null) return false;
  const error = body.error as Record<string, unknown>;
  return error.code === "auth_required" && text(error.message, 512);
}

/** Mirrors apps/api's `META_KEY_RE` (file-metadata.ts) — lowercase, optionally dotted. */
const META_KEY_RE = /^[a-z][a-z0-9._-]{0,63}$/;
/** Mirrors apps/api's `META_MAX_KEYS`/`META_VALUE_MAX` caps for one file's metadata map. */
const META_MAX_KEYS = 24;
const META_VALUE_MAX = 512;

/** Bounded, non-empty `Record<string,string>` of metadata pairs — never sent empty by the API. */
function isMetadataMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > META_MAX_KEYS) return false;
  return entries.every(([key, v]) => META_KEY_RE.test(key) && text(v, META_VALUE_MAX));
}

/** Bounded `github` convenience object — mirrors apps/api's `deriveGithubContext` shape. */
function isGithubContext(value: unknown): value is GithubContext {
  if (typeof value !== "object" || value === null) return false;
  const github = value as Record<string, unknown>;
  return (
    text(github.repo, 200) &&
    (github.kind === "pull" || github.kind === "issue") &&
    Number.isSafeInteger(github.number) &&
    (github.number as number) > 0 &&
    httpsUrl(github.url)
  );
}

/** Validate an untrusted API response against the bounded {@link PublicFile} shape. */
export function isPublicFile(value: unknown): value is PublicFile {
  if (typeof value !== "object" || value === null) return false;
  const file = value as Record<string, unknown>;
  const uploadedOk =
    file.uploaded === undefined ||
    file.uploaded === null ||
    (text(file.uploaded, 64) && Number.isFinite(Date.parse(file.uploaded as string)));
  const metadataOk = file.metadata === undefined || isMetadataMap(file.metadata);
  const githubOk = file.github === undefined || isGithubContext(file.github);
  return (
    text(file.workspace, 64) &&
    text(file.key, 1024) &&
    httpsUrl(file.url) &&
    nullableHttpsUrl(file.embedUrl) &&
    Number.isSafeInteger(file.size) &&
    (file.size as number) >= 0 &&
    text(file.contentType, 128) &&
    uploadedOk &&
    metadataOk &&
    githubOk
  );
}

/**
 * Resolve one public object's metadata from the API.
 *
 * Rejects unsafe workspace/key inputs up front, restricts the origin to
 * `https:` (or loopback `http:` for dev), and validates the response before
 * returning. Maps a 404 to `not_found` and any other failure to `unavailable`.
 */
export async function fetchPublicFile(
  workspace: string,
  key: string,
  options: { origin: string; fetch?: typeof globalThis.fetch; timeoutMs?: number },
): Promise<FileFetchResult> {
  if (!WORKSPACE_PATTERN.test(workspace) || !isSafeKey(key)) return { status: "not_found" };

  let origin: URL;
  try {
    origin = new URL(options.origin);
  } catch {
    return { status: "unavailable" };
  }
  const loopback =
    origin.hostname === "localhost" ||
    origin.hostname === "127.0.0.1" ||
    origin.hostname === "[::1]";
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback))
    return { status: "unavailable" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4000);
  try {
    const endpoint = new URL(
      `/public/files/${encodeURIComponent(workspace)}/${encodeKey(key)}`,
      origin,
    );
    const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (response.status === 404) return { status: "not_found" };
    if (response.status === 401) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { status: "unavailable" };
      }
      return isAuthRequiredError(body) ? { status: "auth_required" } : { status: "unavailable" };
    }
    if (!response.ok) return { status: "unavailable" };
    const value: unknown = await response.json();
    return isPublicFile(value)
      ? { status: "ok", file: { ...value, uploaded: value.uploaded ?? null } }
      : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/** Human-readable byte size for the metadata block. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
