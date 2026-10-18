/**
 * Pure helpers for the operator classifier page (`/admin/classifier`):
 * shares, coverage, flag labels, and file-page links.
 *
 * A missing safety key means "not classified" (or under the confidence
 * floor), never "clean". Nothing here infers a clean answer from absence.
 */
import type {
  ClassifierConfidenceBucket,
  ClassifierFlaggedFile,
  ClassifierSafetyField,
  ClassifierValueCount,
} from "@uploads/api/classifier-admin-wire";
import { filePath } from "./public-file";

export type FlagBadgeVariant = "destructive" | "secondary" | "outline";

/** Integer-or-one-decimal percent, "0%" when the total is zero. */
export function sharePercent(count: number, total: number): string {
  if (!(total > 0) || !(count > 0)) return "0%";
  const pct = (count / total) * 100;
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct < 0.1) return "<0.1%";
  return `${(Math.round(pct * 10) / 10).toString()}%`;
}

/** Rows with their share of the table total. */
export function withShares(
  rows: readonly ClassifierValueCount[],
): Array<ClassifierValueCount & { share: string }> {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return rows.map((row) => ({ ...row, share: sharePercent(row.count, total) }));
}

/**
 * Classified uploads in the window over platform uploads in the window.
 * Approximate: only allowlisted workspaces are classified. Null when the
 * platform count is unavailable or zero.
 */
export function coverageLabel(
  daily: ReadonlyArray<{ classified: number }>,
  windowUploads: number | null,
): string | null {
  if (windowUploads === null || !(windowUploads > 0)) return null;
  const classified = daily.reduce((sum, d) => sum + d.classified, 0);
  return sharePercent(classified, windowUploads);
}

/** Non-clean values only, for the "top flagged values" cell. */
export function topFlaggedValues(
  values: readonly ClassifierValueCount[],
  cleanValue: string,
  limit = 3,
): ClassifierValueCount[] {
  return values.filter((v) => v.value !== cleanValue && v.count > 0).slice(0, limit);
}

export function flagLabel(flag: { field: ClassifierSafetyField; value: string }): string {
  return `${flag.field}: ${flag.value}`;
}

/** High confidence is the one that needs a look; the rest are quieter. */
export function flagVariant(confidence: ClassifierConfidenceBucket | null): FlagBadgeVariant {
  if (confidence === "high") return "destructive";
  if (confidence === "medium") return "secondary";
  return "outline";
}

export function flagTitle(flag: { confidence: ClassifierConfidenceBucket | null }): string {
  return flag.confidence ? `${flag.confidence} confidence` : "confidence not stored";
}

/** Public file page for a flagged file; slashes kept, segments encoded. */
export function flaggedFileHref(file: Pick<ClassifierFlaggedFile, "workspace" | "key">): string {
  return filePath(file.workspace, file.key);
}
