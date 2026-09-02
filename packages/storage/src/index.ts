import { Files, type StoredFile } from "files-sdk";
export { createFilesRouter } from "files-sdk/api";
import { r2, s3FetchAdapter } from "files-sdk/r2";

/** Discriminant for {@link StorageConfig}. Adding a provider = add a case in `createStorage` plus its peer deps. */
export type StorageProvider = "r2" | "s3";

/** R2 jurisdictions with dedicated S3 endpoints (Cloudflare: eu = European Union, fedramp = FedRAMP). */
export const R2_JURISDICTIONS = ["eu", "fedramp"] as const;
export type R2Jurisdiction = (typeof R2_JURISDICTIONS)[number];

/** Type guard for {@link R2Jurisdiction} — use on untrusted strings before they reach `StorageConfig`. */
export function isR2Jurisdiction(value: string): value is R2Jurisdiction {
  return (R2_JURISDICTIONS as readonly string[]).includes(value);
}

/** Fields shared by every provider's config. */
interface StorageConfigBase {
  bucket: string;
  /** Public base URL for objects served off a custom domain (e.g. https://media.example.com). */
  publicBaseUrl?: string;
  /**
   * Key prefix all operations are confined under (e.g. "myws/"). Must end
   * with "/". Applied via files-sdk's instance prefix; clients never see it.
   */
  prefix?: string;
}

export interface R2StorageConfig extends StorageConfigBase {
  provider: "r2";
  /** R2: Workers binding. When set, reads/writes go through the binding (no egress). */
  r2Binding?: R2Bucket;
  /** S3-style HTTP credentials — required for url()/signedUploadUrl(), optional otherwise when a binding exists. */
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * R2 jurisdiction the bucket was created in. Jurisdiction buckets are only
   * reachable at `https://<accountId>.<jurisdiction>.r2.cloudflarestorage.com`,
   * so this switches the S3 endpoint used for HTTP I/O and hybrid-mode
   * signing. Ignored only in pure binding mode (no HTTP credentials), where
   * the wrangler binding declaration carries the jurisdiction and nothing
   * ever touches the S3 endpoint.
   */
  jurisdiction?: R2Jurisdiction;
}

/** Config shape for `provider: "s3"` — a BYO S3-compatible bucket driven purely over HTTP. */
export interface S3StorageConfig extends StorageConfigBase {
  provider: "s3";
  /**
   * Service endpoint origin, e.g. `https://s3.us-east-1.amazonaws.com` or an
   * S3-compatible provider's endpoint.
   */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** SigV4 signing region, e.g. "us-east-1". Defaults to "us-east-1". */
  region?: string;
  /**
   * Use path-style addressing (`https://endpoint/bucket/key`) instead of
   * virtual-hosted style (`https://bucket.endpoint/key`).
   */
  forcePathStyle?: boolean;
}

/**
 * Provider-agnostic storage config. `provider` selects both the files-sdk
 * adapter and which variant's fields are required — a discriminated union so
 * an incomplete `"s3"` config (missing `endpoint`/`accessKeyId`/`secretAccessKey`)
 * fails to compile rather than reaching `createStorage` with `undefined`
 * credentials. Adding a provider = add a variant here plus a case in
 * `createStorage`.
 */
export type StorageConfig = R2StorageConfig | S3StorageConfig;

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
        // Jurisdiction switches the S3 endpoint for HTTP I/O and hybrid-mode
        // signing alike; pure binding mode (no HTTP creds) never builds an S3
        // client, so the extra option is inert there.
        ...(config.jurisdiction && {
          endpoint: `https://${config.accountId}.${config.jurisdiction}.r2.cloudflarestorage.com`,
        }),
      };
      // Binding mode (hybrid when HTTP creds are also set) vs pure HTTP mode.
      // Pure HTTP mode pins `client: "fetch"` (aws4fetch): the default
      // aws-sdk client parses S3 XML with DOMParser in Workers-style bundles,
      // which workerd doesn't provide — list() throws "DOMParser is not
      // defined" at runtime. Binding mode never touches an S3 client for I/O
      // and its hybrid signer is already aws4fetch, so it needs no override.
      const adapter = config.r2Binding
        ? r2({ binding: config.r2Binding, bucket: config.bucket, ...shared })
        : r2({ bucket: config.bucket, client: "fetch", ...shared });
      return new Files({ adapter, prefix: config.prefix });
    }
    case "s3": {
      // `config` is narrowed to `S3StorageConfig` by the discriminant, so
      // `endpoint`/`accessKeyId`/`secretAccessKey` are guaranteed present at
      // compile time — an incomplete config fails to build before it gets
      // here. Re-check at runtime anyway: `config` can still arrive from an
      // untyped caller (JS, `as`, a deserialized request body), and a missing
      // credential must fail loudly here rather than as an opaque signing
      // error deep inside aws4fetch.
      if (!config.endpoint || !config.accessKeyId || !config.secretAccessKey) {
        throw new Error("s3 storage config requires endpoint, accessKeyId, and secretAccessKey");
      }
      const adapter = s3FetchAdapter({
        accessKeyId: config.accessKeyId,
        bucket: config.bucket,
        endpoint: config.endpoint,
        name: "s3-http-fetch",
        providerLabel: "S3 error",
        region: config.region,
        secretAccessKey: config.secretAccessKey,
        ...(config.forcePathStyle !== undefined && { forcePathStyle: config.forcePathStyle }),
        ...(config.publicBaseUrl && { publicBaseUrl: config.publicBaseUrl }),
      });
      return new Files({ adapter, prefix: config.prefix });
    }
    default: {
      const exhaustive: never = config;
      // Report only the provider tag, never the whole config — it carries
      // `secretAccessKey`/`accessKeyId`, and stringifying `exhaustive` would
      // leak them into logs and thrown-error surfaces.
      const provider = (exhaustive as { provider?: unknown }).provider;
      throw new Error(`Unsupported storage provider: ${JSON.stringify(provider)}`);
    }
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

/**
 * Hosts that get an automatic embed twin when no override is set. Exported
 * (issue #929) so the API's daily active-content host sweep
 * (`apps/api/src/active-content-hosts.ts`) derives its hosted-host list from
 * this instead of duplicating the literal hostnames.
 */
export const DEFAULT_EMBEDDABLE_HOSTS = new Set(["storage.uploads.sh", "store.uploads.sh"]);

/**
 * Hostname of a URL string, lowercased; `null` for an empty, missing, or
 * unparseable one. The one copy of this two-line helper — the embed
 * resolution below and the API's active-content host records (issue #929)
 * both key off exactly this normalization, and each used to carry its own.
 */
export function hostOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

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
  const host = hostOf(publicBaseUrl);
  if (host && DEFAULT_EMBEDDABLE_HOSTS.has(host)) return DEFAULT_EMBED_PUBLIC_BASE_URL;
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
    const host = hostOf(publicObjectUrl);
    if (!host) return null;
    if (DEFAULT_EMBEDDABLE_HOSTS.has(host)) {
      const u = new URL(publicObjectUrl);
      publicBaseUrl = `${u.protocol}//${u.host}`;
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

export type { Files, StoredFile };
