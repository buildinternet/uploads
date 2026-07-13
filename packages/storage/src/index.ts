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

export type { Files };
