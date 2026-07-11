import { createStorage, publicUrl, type StorageConfig } from "@uploads/storage";
import { openCredentialFields, secretsKeyRingFromEnv } from "./secrets";
import type { WorkspaceRecord } from "./workspace";

export async function storageConfig(env: Env, ws: WorkspaceRecord): Promise<StorageConfig> {
  let binding: R2Bucket | undefined;
  if (ws.binding) {
    const candidate: unknown = Reflect.get(env, ws.binding);
    if (!candidate || typeof (candidate as R2Bucket).get !== "function") {
      throw new Error(`workspace references unknown R2 binding "${ws.binding}"`);
    }
    binding = candidate as R2Bucket;
  }
  const ring = secretsKeyRingFromEnv(env);
  const opened = await openCredentialFields(ring, {
    accessKeyId: ws.accessKeyId,
    secretAccessKey: ws.secretAccessKey,
  });
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
