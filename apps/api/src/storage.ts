import { createStorage, publicUrl, type StorageConfig } from "@uploads/storage";
import type { WorkspaceRecord } from "./workspace";

export function storageConfig(env: Env, ws: WorkspaceRecord): StorageConfig {
  let binding: R2Bucket | undefined;
  if (ws.binding) {
    const candidate: unknown = Reflect.get(env, ws.binding);
    if (!candidate || typeof (candidate as R2Bucket).get !== "function") {
      throw new Error(`workspace references unknown R2 binding "${ws.binding}"`);
    }
    binding = candidate as R2Bucket;
  }
  return {
    provider: ws.provider,
    bucket: ws.bucket,
    publicBaseUrl: ws.publicBaseUrl,
    r2Binding: binding,
    accountId: ws.accountId,
    accessKeyId: ws.accessKeyId,
    secretAccessKey: ws.secretAccessKey,
  };
}

export function storage(env: Env, ws: WorkspaceRecord) {
  return createStorage(storageConfig(env, ws));
}

export { publicUrl };
