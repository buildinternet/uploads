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
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/installation`, {
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
    const res = await fetchImpl(
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
