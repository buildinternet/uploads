/**
 * Client-side dual-host helpers (published package; no @uploads/storage dep).
 * Keep behavior aligned with packages/storage.
 *
 * `UPLOADS_EMBED_PUBLIC_BASE_URL`: unset = default twin; empty = disable; URL = override.
 */

export const DEFAULT_EMBED_PUBLIC_BASE_URL = "https://embed.uploads.sh";

const DEFAULT_EMBEDDABLE_HOSTS = new Set(["storage.uploads.sh", "store.uploads.sh"]);

export type ClientEmbedUrlOptions = {
  embedBaseUrl?: string | null;
  publicBaseUrl?: string | null;
};

export function embedBaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(env, "UPLOADS_EMBED_PUBLIC_BASE_URL")) {
    return undefined;
  }
  return env.UPLOADS_EMBED_PUBLIC_BASE_URL ?? "";
}

export function resolveEmbedBaseUrl(
  publicBaseUrl?: string | null,
  embedBaseUrl?: string | null,
): string | null {
  if (embedBaseUrl != null) {
    const trimmed = embedBaseUrl.trim();
    return trimmed ? trimmed.replace(/\/$/, "") : null;
  }
  if (!publicBaseUrl) return null;
  try {
    const host = new URL(publicBaseUrl).hostname.toLowerCase();
    if (DEFAULT_EMBEDDABLE_HOSTS.has(host)) return DEFAULT_EMBED_PUBLIC_BASE_URL;
  } catch {
    return null;
  }
  return null;
}

export function embedUrlFromPublic(
  publicObjectUrl: string | null | undefined,
  opts: ClientEmbedUrlOptions = {},
): string | null {
  if (!publicObjectUrl) return null;

  let publicBaseUrl = opts.publicBaseUrl ?? null;
  if (!publicBaseUrl) {
    try {
      const u = new URL(publicObjectUrl);
      if (DEFAULT_EMBEDDABLE_HOSTS.has(u.hostname.toLowerCase())) {
        publicBaseUrl = `${u.protocol}//${u.host}`;
      }
    } catch {
      return null;
    }
  }

  const embedBase = resolveEmbedBaseUrl(publicBaseUrl, opts.embedBaseUrl);
  if (!embedBase || !publicBaseUrl) return null;
  const stableBase = publicBaseUrl.replace(/\/$/, "");
  if (publicObjectUrl === stableBase || publicObjectUrl.startsWith(`${stableBase}/`)) {
    return `${embedBase}${publicObjectUrl.slice(stableBase.length)}`;
  }
  return null;
}

/** Prefer API `embedUrl`; otherwise derive (incl. env override). */
export function resolveEmbedUrl(
  publicObjectUrl: string | null | undefined,
  apiEmbedUrl?: string | null,
  opts: ClientEmbedUrlOptions = {},
): string | null {
  if (apiEmbedUrl) return apiEmbedUrl;
  const embedBaseUrl = opts.embedBaseUrl !== undefined ? opts.embedBaseUrl : embedBaseUrlFromEnv();
  return embedUrlFromPublic(publicObjectUrl, { ...opts, embedBaseUrl });
}

/** Prefer embed host for GitHub markdown; fall back to stable public URL. */
export function urlForGithubEmbed(
  publicObjectUrl: string | null | undefined,
  apiEmbedUrl?: string | null,
  opts: ClientEmbedUrlOptions = {},
): string | null {
  if (!publicObjectUrl) return null;
  return resolveEmbedUrl(publicObjectUrl, apiEmbedUrl, opts) ?? publicObjectUrl;
}
