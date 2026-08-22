import { ServiceUnavailableError } from "@uploads/errors";
import {
  createStorage,
  publicAndEmbedUrls,
  publicUrl,
  type EmbedUrlOptions,
  type Files,
  type StorageConfig,
} from "@uploads/storage";
import { openCredentialFields, secretsKeyRingFromEnv } from "./secrets";
import type { StorageLane, StorageLaneFields, WorkspaceRecord } from "./workspace";

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

/**
 * Shared binding lookup + credential opening for both the active lane
 * (`storageConfig`) and fallback lanes (`storageConfigs`/`resolveObjectLane`).
 * Single enforcement point for `provider`: only `"r2"` is ever a valid
 * `StorageConfig.provider`, so every caller — active or fallback — goes
 * through this check rather than validating it themselves.
 */
async function resolveStorageConfig(env: Env, fields: StorageLaneFields): Promise<StorageConfig> {
  if (fields.provider !== "r2") {
    throw new ServiceUnavailableError(`unsupported storage provider "${fields.provider}"`, {
      code: "storage_misconfigured",
      details: { provider: fields.provider },
    });
  }
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
 * Resolve one fallback lane's config, or `null` if it's a standby lane (no
 * `lastActiveAt` — pure saved configuration, never a read source) or if it
 * fails to resolve (bad binding name, undecryptable creds, unsupported
 * provider — logged, never thrown, so a stale fallback can never take down
 * the active lane).
 */
async function resolveFallbackLane(env: Env, lane: StorageLane): Promise<StorageConfig | null> {
  if (!lane.lastActiveAt) return null;
  try {
    return await resolveStorageConfig(env, lane);
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "storage_lane_skipped",
        laneId: lane.id,
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/**
 * Active lane first, then fallback lanes (`lastActiveAt` set) in array
 * order. Standby lanes are excluded. Active-lane failures still throw
 * exactly as `storageConfig` does today; a fallback lane that fails to
 * resolve is skipped (see `resolveFallbackLane`). Resolves every lane's
 * config up front — the right choice for a listing/status caller that needs
 * them all; `resolveObjectLane` below resolves lazily instead, since it
 * usually needs at most one.
 */
export async function storageConfigs(env: Env, ws: WorkspaceRecord): Promise<LaneConfig[]> {
  const configs: LaneConfig[] = [
    { laneId: ws.storageLaneId ?? null, role: "active", config: await storageConfig(env, ws) },
  ];

  for (const lane of ws.storageLanes ?? []) {
    const config = await resolveFallbackLane(env, lane);
    if (config) configs.push({ laneId: lane.id, role: "fallback", config });
  }

  return configs;
}

/** A storage lane resolved to a live `Files` instance, for object-level operations. */
export interface ResolvedLane extends LaneConfig {
  store: Files;
}

/**
 * Resolves and caches each lane's store/config at most once per resolver
 * instance — a batch of `resolve()` calls against many keys (gallery
 * hydration, comment poster URLs, …) shares one active-lane resolve and one
 * resolve per *distinct* fallback lane actually needed, instead of
 * re-decrypting the same lane's credentials on every call. `resolveObjectLane`
 * below is exactly `createLaneResolver(env, ws).resolve(key)` for a single
 * lookup — both share this same lazy, cached machinery.
 */
export interface LaneResolver {
  /**
   * Walk lanes in order (active, then fallbacks) — first `store.exists(key)`
   * hit wins. Returns `null` when the key exists in no lane. Resolves
   * lazily: a fallback lane's config (and its credential decrypt) is only
   * resolved once some earlier call has missed every lane before it, so the
   * common case — the active lane has the key — never touches fallback
   * credentials at all. Single-lane records short-circuit to exactly one
   * `exists` call.
   */
  resolve(key: string): Promise<ResolvedLane | null>;
  /** The active lane's store, resolved (and cached) the same way `resolve` would — for a caller that already knows it's writing to (or otherwise doesn't need to search past) the active lane. */
  activeStore(): Promise<Files>;
  /** The active lane's config, resolved (and cached) the same way `resolve` would. */
  activeConfig(): Promise<StorageConfig>;
}

export function createLaneResolver(env: Env, ws: WorkspaceRecord): LaneResolver {
  let activePromise: Promise<{ store: Files; config: StorageConfig }> | undefined;
  const active = () => {
    activePromise ??= (async () => {
      const config = await storageConfig(env, ws);
      return { store: createStorage(config), config };
    })();
    return activePromise;
  };

  const fallbackPromises = new Map<
    string,
    Promise<{ store: Files; config: StorageConfig } | null>
  >();
  const fallback = (lane: StorageLane) => {
    let promise = fallbackPromises.get(lane.id);
    if (!promise) {
      promise = (async () => {
        const config = await resolveFallbackLane(env, lane);
        return config ? { store: createStorage(config), config } : null;
      })();
      fallbackPromises.set(lane.id, promise);
    }
    return promise;
  };

  return {
    async activeStore() {
      return (await active()).store;
    },
    async activeConfig() {
      return (await active()).config;
    },
    async resolve(key) {
      const { store: activeStore, config: activeConfig } = await active();
      if (await activeStore.exists(key)) {
        return {
          store: activeStore,
          config: activeConfig,
          laneId: ws.storageLaneId ?? null,
          role: "active",
        };
      }
      for (const lane of ws.storageLanes ?? []) {
        const resolved = await fallback(lane);
        if (!resolved) continue;
        if (await resolved.store.exists(key)) {
          return {
            store: resolved.store,
            config: resolved.config,
            laneId: lane.id,
            role: "fallback",
          };
        }
      }
      return null;
    },
  };
}

/** Single-lookup convenience wrapper over `createLaneResolver` — see its docs for the lazy/cached resolution contract. A caller resolving several keys against the same `ws` should build one resolver and call `.resolve()` on it directly instead. */
export async function resolveObjectLane(
  env: Env,
  ws: WorkspaceRecord,
  key: string,
): Promise<ResolvedLane | null> {
  return createLaneResolver(env, ws).resolve(key);
}

export { publicUrl };
