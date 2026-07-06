import { createStorage, publicUrl, type StorageConfig } from "@uploads/storage";

export function storageConfig(env: Env): StorageConfig {
  return {
    provider: env.STORAGE_PROVIDER as StorageConfig["provider"],
    bucket: env.STORAGE_BUCKET,
    publicBaseUrl: env.PUBLIC_BASE_URL || undefined,
    r2Binding: env.UPLOADS,
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  };
}

export function storage(env: Env) {
  return createStorage(storageConfig(env));
}

export { publicUrl };
