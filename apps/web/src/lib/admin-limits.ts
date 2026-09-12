/**
 * Pure byte/unit helpers for the admin Limits editor, lifted verbatim from the
 * imperative admin page so the plan-default / unit / unlimited semantics are
 * unchanged by the React rewrite. Decimal SI only — plan caps and display use
 * 1000-based MB/GB (not MiB/GiB), matching @uploads/billing's catalog values.
 */
import type { AdminLimitsResponse } from "@uploads/api/admin-ui";

export const LIMIT_UNITS: { label: string; mult: number }[] = [
  { label: "MB", mult: 1_000_000 },
  { label: "GB", mult: 1_000_000_000 },
];

export const LIMIT_FIELDS: {
  key: keyof AdminLimitsResponse["limits"];
  label: string;
  byte: boolean;
}[] = [
  { key: "maxStorageBytes", label: "Storage", byte: true },
  { key: "maxUploadsPerPeriod", label: "Uploads / month", byte: false },
  { key: "maxUploadBytes", label: "Max file size", byte: true },
  { key: "maxVideoUploadBytes", label: "Max video size", byte: true },
  // Members, not bytes: the invite-time cap from issue #450. Editing it here is
  // how an operator comps an exception to the free-plan cap.
  { key: "maxMembers", label: "Members", byte: false },
];

/** Pick a friendly unit + value for a byte count (exact GB > MB). */
export function splitBytes(n: number): { value: number; unit: string } {
  for (const u of [...LIMIT_UNITS].reverse()) {
    if (n % u.mult === 0) return { value: n / u.mult, unit: u.label };
  }
  return { value: n / 1_000_000, unit: "MB" };
}

export function formatBytes(n: number): string {
  const { value, unit } = splitBytes(n);
  return `${value} ${unit}`;
}

export function multForUnit(unit: string): number {
  return LIMIT_UNITS.find((u) => u.label === unit)?.mult ?? 1_000_000;
}
