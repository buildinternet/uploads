/**
 * Record template for self-serve workspaces (spec 2026-07-14, D3).
 * Deliberately tighter than the operator template in
 * scripts/workspace-limit-defaults.json (25 GB): self-serve tenants start at
 * free-plan limits from `@uploads/billing` (250 MB / 3000 uploads per UTC
 * month); raises are admin-only. Uploads are WebP-converted by default, so
 * 250 MB of stored assets holds far more screenshots than the raw byte
 * figure suggests.
 *
 * Budget numbers come from `PLANS.free.defaultLimits` so plan resolution and
 * self-serve provisioning cannot drift.
 */
import { PLANS } from "@uploads/billing";
import type { WorkspaceRecord } from "./workspace";

const freeLimits = PLANS.free.defaultLimits;

export const SELF_SERVE_LIMITS = {
  maxStorageBytes: freeLimits.maxStorageBytes!,
  maxUploadsPerPeriod: freeLimits.maxUploadsPerPeriod!,
  maxUploadBytes: freeLimits.maxUploadBytes!,
  maxVideoUploadBytes: freeLimits.maxVideoUploadBytes!,
  allowedKeyPrefixes: ["f", "screenshots", "gh"] as const,
  maxKeyDepth: 8,
} as const;

export function selfServeWorkspaceRecord(args: {
  name: string;
  userId: string;
  now: Date;
}): WorkspaceRecord {
  return {
    name: args.name,
    // First write of a brand-new record (issue #387); every later mutation
    // goes through `mutateWorkspaceRecord`, which bumps this.
    version: 1,
    provider: "r2",
    bucket: "uploads-default",
    binding: "UPLOADS_DEFAULT",
    prefix: `${args.name}/`,
    publicBaseUrl: "https://storage.uploads.sh",
    selfServe: true,
    createdByUserId: args.userId,
    createdAt: args.now.toISOString(),
    // Plan drives limit resolution (issue #412) — the explicit budget
    // fields are deliberately NOT stamped here (same reasoning as
    // `maxMembers`/#450 below): stamping them would beat the plan default
    // forever, including after an upgrade to Pro (issue #454). Free's
    // numbers still come from `PLANS.free.defaultLimits` via
    // `resolveEffectiveLimits` (packages/billing/src/resolve.ts), so
    // provisioning and plan resolution cannot drift.
    plan: "free",
    allowedKeyPrefixes: [...SELF_SERVE_LIMITS.allowedKeyPrefixes],
    maxKeyDepth: SELF_SERVE_LIMITS.maxKeyDepth,
  };
}
