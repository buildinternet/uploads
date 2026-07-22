/**
 * GitHub owner avatar proxy.
 *
 * PR/issue surfaces need a first-party image URL for the repo owner from
 * `gh.repo` (`owner/name`). We proxy `https://github.com/{owner}.png` (edge-
 * cached) so pages don't hotlink avatars.githubusercontent.com. Display-only:
 * non-2xx means "no avatar"; never on the upload path.
 */

/** GitHub login / org slug: 1–39 chars, alphanumeric + mid hyphens only. */
export const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_AVATAR_BYTES = 512 * 1024;

export const POSITIVE_CACHE_CONTROL = "public, max-age=86400, stale-while-revalidate=604800";
export const NEGATIVE_CACHE_CONTROL = "public, max-age=3600";

export interface AvatarCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** Lowercased login when valid, else null. */
export function normalizeGithubOwner(raw: string): string | null {
  const owner = raw.trim();
  if (!GITHUB_OWNER_RE.test(owner)) return null;
  return owner.toLowerCase();
}

/** Owner of `owner/repo`, or null if malformed. */
export function ownerFromRepo(repo: string): string | null {
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash !== repo.lastIndexOf("/") || !repo.slice(slash + 1)) return null;
  return normalizeGithubOwner(repo.slice(0, slash));
}

/** Absolute proxy URL (`{apiOrigin}/public/github/avatars/{owner}`). */
export function githubAvatarProxyUrl(apiOrigin: string, owner: string): string {
  return `${apiOrigin.replace(/\/$/, "")}/public/github/avatars/${encodeURIComponent(owner)}`;
}

function avatarResponse(
  status: number,
  cacheControl: string,
  body: BodyInit | null = null,
  contentType?: string,
): Response {
  const headers = new Headers({
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  });
  if (contentType) headers.set("Content-Type", contentType);
  return new Response(body, { status, headers });
}

function isImageContentType(value: string | null): boolean {
  const type = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  return type.startsWith("image/");
}

async function putCache(
  cache: AvatarCache | null | undefined,
  key: Request,
  response: Response,
): Promise<void> {
  if (!cache) return;
  await cache.put(key, response.clone());
}

/**
 * Cache hit → return; else fetch GitHub's `/{owner}.png`, validate, cache, return.
 * `cacheKeyUrl` is the normalized public URL for this owner.
 */
export async function resolveGithubAvatar(
  owner: string,
  opts: {
    cacheKeyUrl: string;
    fetchImpl?: typeof fetch;
    cache?: AvatarCache | null;
  },
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cacheKey = new Request(opts.cacheKeyUrl, { method: "GET" });

  const hit = await opts.cache?.match(cacheKey);
  if (hit) return hit;

  let upstream: Response;
  try {
    upstream = await fetchImpl(`https://github.com/${owner}.png`, {
      redirect: "follow",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { accept: "image/*", "user-agent": "uploads.sh" },
    });
  } catch {
    // Network / timeout — don't cache; next request can retry immediately.
    return avatarResponse(502, NEGATIVE_CACHE_CONTROL);
  }

  if (!upstream.ok || !isImageContentType(upstream.headers.get("content-type"))) {
    const status = upstream.status === 404 ? 404 : 502;
    const negative = avatarResponse(status, NEGATIVE_CACHE_CONTROL);
    await putCache(opts.cache, cacheKey, negative);
    return negative;
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await upstream.arrayBuffer();
  } catch {
    return avatarResponse(502, NEGATIVE_CACHE_CONTROL);
  }

  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_BYTES) {
    const negative = avatarResponse(502, NEGATIVE_CACHE_CONTROL);
    await putCache(opts.cache, cacheKey, negative);
    return negative;
  }

  const response = avatarResponse(
    200,
    POSITIVE_CACHE_CONTROL,
    bytes,
    upstream.headers.get("content-type") ?? "image/png",
  );
  await putCache(opts.cache, cacheKey, response);
  return response;
}

/** Cloudflare Cache API when present; null in unit tests / non-Workers runtimes. */
export function defaultAvatarCache(): AvatarCache | null {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}
