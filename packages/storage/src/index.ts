import { Files } from "files-sdk";
export { createFilesRouter } from "files-sdk/api";
import { r2 } from "files-sdk/r2";

/**
 * Provider-agnostic storage config. `provider` selects the files-sdk adapter;
 * everything else is the superset of fields the supported adapters need.
 * Adding a provider = add a case in `createStorage` plus its peer deps.
 */
export type StorageProvider = "r2";

export interface StorageConfig {
  provider: StorageProvider;
  bucket: string;
  /** Public base URL for objects served off a custom domain (e.g. https://media.example.com). */
  publicBaseUrl?: string;
  /** R2: Workers binding. When set, reads/writes go through the binding (no egress). */
  r2Binding?: R2Bucket;
  /** S3-style HTTP credentials — required for url()/signedUploadUrl(), optional otherwise when a binding exists. */
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * Key prefix all operations are confined under (e.g. "myws/"). Must end
   * with "/". Applied via files-sdk's instance prefix; clients never see it.
   */
  prefix?: string;
}

/** Segments of lowercase alphanumerics/._- each ending in "/"; first char alphanumeric (so "." and ".." are impossible). */
const PREFIX_RE = /^([a-z0-9][a-z0-9._-]*\/)+$/;

export function createStorage(config: StorageConfig): Files {
  if (config.prefix !== undefined && !PREFIX_RE.test(config.prefix)) {
    throw new Error(`invalid storage prefix: ${JSON.stringify(config.prefix)}`);
  }
  switch (config.provider) {
    case "r2": {
      const shared = {
        accountId: config.accountId,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        publicBaseUrl: config.publicBaseUrl,
      };
      // Binding mode (hybrid when HTTP creds are also set) vs pure HTTP mode.
      const adapter = config.r2Binding
        ? r2({ binding: config.r2Binding, bucket: config.bucket, ...shared })
        : r2({ bucket: config.bucket, ...shared });
      return new Files({ adapter, prefix: config.prefix });
    }
    default:
      throw new Error(`Unsupported storage provider: ${config.provider satisfies never}`);
  }
}

/** Public URL for a key when the bucket is fronted by a custom domain. Includes the workspace prefix. */
export function publicUrl(config: StorageConfig, key: string): string | null {
  if (!config.publicBaseUrl) return null;
  const base = config.publicBaseUrl.replace(/\/$/, "");
  const fullKey = `${config.prefix ?? ""}${key}`;
  return `${base}/${fullKey.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * Embed twin for the shared bucket (`embed.uploads.sh`): same keys as the
 * durable storage host, badge-style Cache-Control via zone Transform Rule so
 * GitHub Camo revalidates after in-place overwrites.
 */
export const DEFAULT_EMBED_PUBLIC_BASE_URL = "https://embed.uploads.sh";

/** Hosts that get an automatic embed twin when no override is set. */
const DEFAULT_EMBEDDABLE_HOSTS = new Set(["storage.uploads.sh", "store.uploads.sh"]);

export type EmbedUrlOptions = {
  /**
   * Embed CDN base.
   * - omit → default twin when `publicBaseUrl` host is embeddable
   * - empty string → disable
   * - URL → self-hosted override
   */
  embedBaseUrl?: string | null;
};

/** Resolve embed CDN base for a workspace public base (or disable / override). */
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

/**
 * Map a stable public object URL to the embed twin.
 * When `publicBaseUrl` is omitted, infers it from known embeddable hosts on the URL.
 */
export function embedUrlFromPublic(
  publicObjectUrl: string | null | undefined,
  opts: EmbedUrlOptions & { publicBaseUrl?: string | null } = {},
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

/** Stable + embed public URLs for a key (either may be null). */
export function publicAndEmbedUrls(
  config: StorageConfig,
  key: string,
  opts?: EmbedUrlOptions,
): { url: string | null; embedUrl: string | null } {
  const url = publicUrl(config, key);
  return {
    url,
    embedUrl: embedUrlFromPublic(url, {
      publicBaseUrl: config.publicBaseUrl,
      embedBaseUrl: opts?.embedBaseUrl,
    }),
  };
}

/** Options for {@link signedDownloadUrl}. */
export interface SignedDownloadUrlOptions {
  /** How long the URL stays valid, in seconds. Defaults to 3600 (files-sdk's own default). */
  expiresIn?: number;
}

/**
 * Short-lived signed download URL for `key`, or `null` when the adapter has
 * no signing primitive to mint one — e.g. an R2 binding with neither
 * `publicBaseUrl` nor HTTP credentials (`accountId`/`accessKeyId`/`secretAccessKey`).
 * Mirrors {@link Files.signedUploadUrl}'s presigning, but for reads: it forces
 * `responseContentDisposition: "attachment"` so a user-uploaded HTML/SVG never
 * renders inline at the bucket's origin (stored XSS).
 *
 * Checks {@link Files.capabilities}' `signedUrl.supported` flag up front so
 * callers get a clean `null` instead of a thrown provider error when signing
 * isn't possible. Callers should try {@link publicUrl} first — a workspace
 * with `publicBaseUrl` configured should get its stable custom-domain URL
 * instead of a short-lived signed one.
 */
export async function signedDownloadUrl(
  store: Files,
  key: string,
  opts: SignedDownloadUrlOptions = {},
): Promise<string | null> {
  if (!store.capabilities.signedUrl.supported) return null;
  return store.url(key, {
    expiresIn: opts.expiresIn ?? 3600,
    responseContentDisposition: "attachment",
  });
}

export type { Files };
