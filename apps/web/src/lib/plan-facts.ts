// Plan numbers for /docs/limits, read from the plan catalog at build time so
// the page cannot drift from what the API actually enforces.
import { PLANS } from "@uploads/billing";

// Marketed byte values are clean decimal numbers (250 MB, 10 GB), so a
// simple unit walk formats them exactly.
function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${bytes / 1_000_000_000} GB`;
  return `${bytes / 1_000_000} MB`;
}

const free = PLANS.free.defaultLimits;
const pro = PLANS.pro.defaultLimits;

export const PLAN_FACTS = {
  freeName: PLANS.free.name,
  proName: PLANS.pro.name,
  freeStorage: formatBytes(free.maxStorageBytes!),
  proStorage: formatBytes(pro.maxStorageBytes!),
  freeMaxUpload: formatBytes(free.maxUploadBytes!),
  proMaxUpload: formatBytes(pro.maxUploadBytes!),
  freeMaxVideo: formatBytes(free.maxVideoUploadBytes!),
  proMaxVideo: formatBytes(pro.maxVideoUploadBytes!),
  freeMembers: String(free.maxMembers),
} as const;

export type PlanFact = keyof typeof PLAN_FACTS;
