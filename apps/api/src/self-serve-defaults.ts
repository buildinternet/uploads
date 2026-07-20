/**
 * Record template for self-serve workspaces (spec 2026-07-14, D3).
 * Deliberately tighter than the operator template in
 * scripts/workspace-limit-defaults.json (25 GB): self-serve tenants start at
 * 250 MB / 3000 uploads per UTC month; raises are admin-only. Uploads are
 * WebP-converted by default, so 250 MB of stored assets holds far more
 * screenshots than the raw byte figure suggests.
 */
import type { WorkspaceRecord } from "./workspace";

export const SELF_SERVE_LIMITS = {
  maxStorageBytes: 250_000_000,
  maxUploadsPerPeriod: 3000,
  maxUploadBytes: 25_000_000,
  maxVideoUploadBytes: 8_000_000,
  allowedKeyPrefixes: ["f", "screenshots", "gh"] as const,
  maxKeyDepth: 8,
} as const;

export function selfServeWorkspaceRecord(args: {
  name: string;
  userId: string;
  now: Date;
}): WorkspaceRecord {
  return {
    provider: "r2",
    bucket: "uploads-default",
    binding: "UPLOADS_DEFAULT",
    prefix: `${args.name}/`,
    publicBaseUrl: "https://storage.uploads.sh",
    selfServe: true,
    createdByUserId: args.userId,
    createdAt: args.now.toISOString(),
    maxStorageBytes: SELF_SERVE_LIMITS.maxStorageBytes,
    maxUploadsPerPeriod: SELF_SERVE_LIMITS.maxUploadsPerPeriod,
    maxUploadBytes: SELF_SERVE_LIMITS.maxUploadBytes,
    maxVideoUploadBytes: SELF_SERVE_LIMITS.maxVideoUploadBytes,
    allowedKeyPrefixes: [...SELF_SERVE_LIMITS.allowedKeyPrefixes],
    maxKeyDepth: SELF_SERVE_LIMITS.maxKeyDepth,
  };
}
