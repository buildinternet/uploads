/**
 * Cloudflare edge-cache invalidation for objects served off a zone we control.
 *
 * R2 custom domains edge-cache cacheable objects (e.g. images) under a default
 * TTL, so overwriting a key at a stable URL keeps serving the old body until the
 * TTL lapses. `Cache-Control: max-age=60` on upload bounds that everywhere; for
 * the core `uploads.sh` zone we additionally purge the exact URL on write so
 * our edge serves fresh bytes immediately.
 *
 * Scope note: this evicts OUR Cloudflare edge only. GitHub embeds are proxied
 * through Camo/Fastly, which keeps its own cache we can't purge — there, the
 * upload `Cache-Control` is what governs how fast a replacement shows up. This
 * purge mainly helps direct storage.uploads.sh viewers.
 *
 * Gated on config: no token / no zone / a host we don't control → no-op, and
 * callers rely on the short TTL instead. Bring-your-own-domain workspaces
 * (different `publicBaseUrl` host) fall through here by design.
 */

/** Hosts whose URLs we're allowed to purge, from `CF_PURGE_HOSTS` (comma-separated). */
function purgeHosts(env: Env): Set<string> {
  return new Set(
    (env.CF_PURGE_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** True when the URL sits on a host we're configured to purge. */
export function isPurgeable(env: Env, url: string): boolean {
  if (!env.CF_PURGE_TOKEN || !env.CF_PURGE_ZONE_ID) return false;
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  return purgeHosts(env).has(host);
}

/**
 * Purge specific URLs from Cloudflare's edge cache. Best-effort: resolves even
 * on failure (logs), since the short Cache-Control is the correctness backstop.
 * Call the guard {@link isPurgeable} first; this assumes token/zone are set.
 */
export async function purgeUrls(env: Env, urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_PURGE_ZONE_ID}/purge_cache`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.CF_PURGE_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ files: urls }),
      },
    );
    if (!res.ok) {
      console.error(
        JSON.stringify({ msg: "cache purge failed", status: res.status, body: await res.text() }),
      );
    }
  } catch (err) {
    console.error(JSON.stringify({ msg: "cache purge error", error: String(err) }));
  }
}
