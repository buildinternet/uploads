/**
 * GitHub App auth for the api worker (spec: .context/267-github-app-titles-design.md).
 * JWT → installation discovery → installation token, each KV-cached in
 * GITHUB_CACHE. Every function degrades to null on failure — callers treat
 * "no token" as "no title", never as an error.
 */

import { b64urlDecode, b64urlEncode } from "./secrets";

export interface GithubAppConfig {
  appId: string;
  privateKey: string;
  homeInstallationId: string;
}

/** All-or-nothing read of the App env members; null disables the integration. */
export function githubAppConfig(env: Env): GithubAppConfig | null {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  const homeInstallationId = env.GITHUB_APP_HOME_INSTALLATION_ID;
  if (!appId || !privateKey || !homeInstallationId) return null;
  return { appId, privateKey, homeInstallationId };
}

// b64urlDecode accepts plain base64 too (the -/_ swaps no-op, PEM bodies are
// already padded), so one shared codec covers both the JWT parts and the key.
function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  return b64urlDecode(body).buffer as ArrayBuffer;
}

/** 10-minute RS256 App JWT, backdated 60s for clock drift. */
export async function appJwt(cfg: GithubAppConfig, nowMs = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(cfg.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const enc = new TextEncoder();
  const now = Math.floor(nowMs / 1000);
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = b64urlEncode(
    enc.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: cfg.appId })),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    enc.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64urlEncode(new Uint8Array(signature))}`;
}

/** Standard headers for every GitHub API call this worker makes. */
export function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "uploads.sh",
    "x-github-api-version": "2022-11-28",
  };
}

const INSTALL_TTL = 3600;
const TOKEN_TTL = 3000; // GitHub tokens live 60min; cache 50.

/**
 * Hard deadline on every outbound GitHub call: the titles endpoint awaits
 * these in the request path, so a hanging upstream must abort fast and fall
 * into each caller's existing degrade-to-null handling.
 */
const GITHUB_FETCH_TIMEOUT_MS = 8000;

/** `fetchImpl` with the standard GitHub deadline attached. */
export function githubFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS) });
}

/**
 * Webhook event types this worker's handler actually reads (see
 * `handleWebhook` in ./github-webhook.ts): `issues`/`pull_request` drive
 * auto-promotion and title-cache invalidation. These are NOT sent unless the
 * App owner ticks them under Settings → Permissions & events → Subscribe to
 * events — unlike `installation`/`installation_repositories`/`ping`, which
 * GitHub always sends regardless of subscription. Issue #293's follow-up:
 * the App shipped with ping green but these two unsubscribed, silently
 * breaking both features.
 */
export const REQUIRED_WEBHOOK_EVENTS = ["issues", "pull_request"] as const;

/**
 * Webhook events that are useful but not load-bearing: `issue_comment`
 * enables bot-comment self-healing (reconciling the managed attachments
 * comment when someone edits/deletes it) but nothing breaks silently without
 * it the way it would for REQUIRED_WEBHOOK_EVENTS. Missing recommended events
 * never flip the health check's `ok` to false — they're surfaced as a
 * separate, non-gating tier (issue #333).
 */
export const RECOMMENDED_WEBHOOK_EVENTS = ["issue_comment"] as const;

/**
 * The App's subscribed webhook events, straight from `GET /app` (App-JWT
 * auth, not installation-token — this is app-level metadata, no installation
 * needed). Returns null on any failure so callers degrade the same way the
 * rest of this module does: "unknown" is never reported as "broken".
 */
export async function appEventSubscriptions(
  cfg: GithubAppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string[] | null> {
  try {
    const res = await githubFetch(fetchImpl, "https://api.github.com/app", {
      headers: githubHeaders(await appJwt(cfg)),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { events?: unknown };
    if (!Array.isArray(body.events)) return null;
    return body.events.filter((e): e is string => typeof e === "string");
  } catch {
    return null;
  }
}

/**
 * Installation id for `repo` ("owner/name"), or null when the App is not
 * installed there. 404 (not installed) is cached as "none"; transient
 * failures are not cached.
 */
export async function installationForRepo(
  env: Env,
  cfg: GithubAppConfig,
  repo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  const key = `ghinst:${repo}`;
  const cached = (await env.GITHUB_CACHE.get(key)) as string | null;
  if (cached !== null) return cached === "none" ? null : Number(cached);
  try {
    const res = await githubFetch(fetchImpl, `https://api.github.com/repos/${repo}/installation`, {
      headers: githubHeaders(await appJwt(cfg)),
    });
    if (res.status === 404) {
      await env.GITHUB_CACHE.put(key, "none", { expirationTtl: INSTALL_TTL });
      return null;
    }
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: number };
    if (typeof body.id !== "number") return null;
    await env.GITHUB_CACHE.put(key, String(body.id), { expirationTtl: INSTALL_TTL });
    return body.id;
  } catch {
    return null;
  }
}

/**
 * Short-lived installation token, KV-cached below its 60-minute life. Tokens
 * are read-only (App permissions) and expire server-side, so KV storage is an
 * accepted trade-off (spec §Components).
 */
export async function installationToken(
  env: Env,
  cfg: GithubAppConfig,
  installationId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const key = `ghtok:${installationId}`;
  const cached = (await env.GITHUB_CACHE.get(key)) as string | null;
  if (cached !== null) return cached;
  try {
    const res = await githubFetch(
      fetchImpl,
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      { method: "POST", headers: githubHeaders(await appJwt(cfg)) },
    );
    if (res.status !== 201) return null;
    const body = (await res.json()) as { token?: string };
    if (typeof body.token !== "string") return null;
    await env.GITHUB_CACHE.put(key, body.token, { expirationTtl: TOKEN_TTL });
    return body.token;
  } catch {
    return null;
  }
}
