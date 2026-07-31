import { ServiceUnavailableError } from "@uploads/errors";
import {
  createStorage,
  publicAndEmbedUrls,
  publicUrl,
  type EmbedUrlOptions,
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

export async function storageConfig(env: Env, ws: WorkspaceRecord): Promise<StorageConfig> {
  let binding: R2Bucket | undefined;
  if (ws.binding) {
    const candidate: unknown = Reflect.get(env, ws.binding);
    if (!candidate || typeof (candidate as R2Bucket).get !== "function") {
      // A config/deploy mismatch (wrangler.jsonc binding renamed or removed
      // while the workspace record still names it) — an operator fix, not a
      // caller mistake, so 503 rather than a 4xx. Never a 500: the route
      // layer's onError translates AppError subclasses via respondError.
      throw new ServiceUnavailableError(`workspace references unknown R2 binding "${ws.binding}"`, {
        code: "storage_misconfigured",
        details: { binding: ws.binding },
      });
    }
    binding = candidate as R2Bucket;
  }
  const ring = secretsKeyRingFromEnv(env);
  let opened: Awaited<ReturnType<typeof openCredentialFields>>;
  try {
    opened = await openCredentialFields(ring, {
      accessKeyId: ws.accessKeyId,
      secretAccessKey: ws.secretAccessKey,
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
    provider: ws.provider,
    bucket: ws.bucket,
    prefix: ws.prefix,
    publicBaseUrl: ws.publicBaseUrl,
    r2Binding: binding,
    accountId: ws.accountId,
    accessKeyId: opened.accessKeyId,
    secretAccessKey: opened.secretAccessKey,
  };
}

export async function storage(env: Env, ws: WorkspaceRecord) {
  return createStorage(await storageConfig(env, ws));
}

export { publicUrl };
