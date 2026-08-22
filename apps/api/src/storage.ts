import { ServiceUnavailableError } from "@uploads/errors";
import {
  createStorage,
  publicAndEmbedUrls,
  publicUrl,
  type EmbedUrlOptions,
  type Files,
  type R2Jurisdiction,
  type StorageConfig,
} from "@uploads/storage";
import { openCredentialFields, secretsKeyRingFromEnv } from "./secrets";
import type { WorkspaceRecord } from "./workspace";

/** Worker env override for the embed CDN base (self-host / disable). */
function embedUrlOptionsFromEnv(env: Env): EmbedUrlOptions {
  // undefined → default twin; "" → disable; else custom base
  if (env.EMBED_PUBLIC_BASE_URL === undefined) return {};
  return { embedBaseUrl: env.EMBED_PUBLIC_BASE_URL };
}

export function objectPublicUrls(
  env: Env,
  cfg: StorageConfig,
  key: string,
): { url: string | null; embedUrl: string | null } {
  return publicAndEmbedUrls(cfg, key, embedUrlOptionsFromEnv(env));
}

/** The storage-field bag shared by a `WorkspaceRecord`'s top-level (active) fields and a `StorageLane`. */
interface StorageFieldsLike {
  bucket: string;
  binding?: string;
  prefix?: string;
  publicBaseUrl?: string;
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  jurisdiction?: R2Jurisdiction;
}

/**
 * Shared binding lookup + credential opening for both the active lane
 * (`storageConfig`) and fallback lanes (`storageConfigs`). Only "r2" is ever
 * a valid `StorageConfig.provider`, so the caller is responsible for
 * validating a lane's `provider` string before calling this — see
 * `storageConfigs`.
 */
async function resolveStorageConfig(env: Env, fields: StorageFieldsLike): Promise<StorageConfig> {
  let binding: R2Bucket | undefined;
  if (fields.binding) {
    const candidate: unknown = Reflect.get(env, fields.binding);
    if (!candidate || typeof (candidate as R2Bucket).get !== "function") {
      // A config/deploy mismatch (wrangler.jsonc binding renamed or removed
      // while the workspace record still names it) — an operator fix, not a
      // caller mistake, so 503 rather than a 4xx. Never a 500: the route
      // layer's onError translates AppError subclasses via respondError.
      throw new ServiceUnavailableError(
        `workspace references unknown R2 binding "${fields.binding}"`,
        { code: "storage_misconfigured", details: { binding: fields.binding } },
      );
    }
    binding = candidate as R2Bucket;
  }
  const ring = secretsKeyRingFromEnv(env);
  let opened: Awaited<ReturnType<typeof openCredentialFields>>;
  try {
    opened = await openCredentialFields(ring, {
      accessKeyId: fields.accessKeyId,
      secretAccessKey: fields.secretAccessKey,
    });
  } catch (err) {
    // Missing/rotated WORKSPACE_SECRETS_KEY, or corrupt ciphertext — surface
    // as a typed, non-retryable-looking 503 with a settings-page hint instead
    // of letting the raw decrypt error bubble as an opaque 500.
    throw new ServiceUnavailableError(
      "workspace storage credentials could not be decrypted; reconfigure storage in workspace settings",
      { code: "storage_credentials_unreadable", cause: err },
    );
  }
  // During rotation, previous-key decrypts still work; re-seal offline with the script.
  if (opened.usedPrevious) {
    console.log(
      JSON.stringify({
        message: "credential_decrypted_with_previous_key",
        hint: "run scripts/reencrypt-workspace-secrets.mjs then remove WORKSPACE_SECRETS_KEY_PREVIOUS",
      }),
    );
  }
  return {
    provider: "r2",
    bucket: fields.bucket,
    prefix: fields.prefix,
    publicBaseUrl: fields.publicBaseUrl,
    r2Binding: binding,
    accountId: fields.accountId,
    accessKeyId: opened.accessKeyId,
    secretAccessKey: opened.secretAccessKey,
    jurisdiction: fields.jurisdiction,
  };
}

export async function storageConfig(env: Env, ws: WorkspaceRecord): Promise<StorageConfig> {
  return resolveStorageConfig(env, ws);
}

export async function storage(env: Env, ws: WorkspaceRecord) {
  return createStorage(await storageConfig(env, ws));
}

/** One resolvable storage configuration, tagged with the lane it came from. */
export interface LaneConfig {
  /** `null` = the pre-lanes implicit active lane (no `storageLaneId` stamped yet). */
  laneId: string | null;
  role: "active" | "fallback";
  config: StorageConfig;
}

/**
 * Active lane first, then fallback lanes (`lastActiveAt` set) in array
 * order. Standby lanes (no `lastActiveAt`) are pure saved configuration and
 * are excluded — they never participate in read resolution. A fallback lane
 * that fails to resolve (bad binding name, undecryptable creds, unsupported
 * provider) is logged and skipped, never throws — a stale fallback must
 * never take down the active lane. Active-lane failures still throw exactly
 * as `storageConfig` does today.
 */
export async function storageConfigs(env: Env, ws: WorkspaceRecord): Promise<LaneConfig[]> {
  const configs: LaneConfig[] = [
    { laneId: ws.storageLaneId ?? null, role: "active", config: await storageConfig(env, ws) },
  ];

  for (const lane of ws.storageLanes ?? []) {
    if (!lane.lastActiveAt) continue; // standby: saved, never active — not a read source.
    if (lane.provider !== "r2") {
      console.error(
        JSON.stringify({
          message: "storage_lane_skipped",
          laneId: lane.id,
          reason: "unsupported_provider",
          provider: lane.provider,
        }),
      );
      continue;
    }
    try {
      const config = await resolveStorageConfig(env, lane);
      configs.push({ laneId: lane.id, role: "fallback", config });
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "storage_lane_skipped",
          laneId: lane.id,
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return configs;
}

/** A storage lane resolved to a live `Files` instance, for object-level operations. */
export interface ResolvedLane {
  store: Files;
  config: StorageConfig;
  laneId: string | null;
  role: "active" | "fallback";
}

/**
 * Walk lanes in order (active, then fallbacks) — first `store.exists(key)`
 * hit wins. Returns `null` when the key exists in no lane. Single-lane
 * records short-circuit to the current behavior: exactly one `exists` call.
 */
export async function resolveObjectLane(
  env: Env,
  ws: WorkspaceRecord,
  key: string,
): Promise<ResolvedLane | null> {
  const configs = await storageConfigs(env, ws);
  for (const lane of configs) {
    const store = createStorage(lane.config);
    if (await store.exists(key)) {
      return { store, config: lane.config, laneId: lane.laneId, role: lane.role };
    }
  }
  return null;
}

export { publicUrl };
