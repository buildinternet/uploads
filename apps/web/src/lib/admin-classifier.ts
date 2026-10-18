/**
 * Pure helpers for the operator classifier page (`/admin/classifier`):
 * shares, coverage, flag labels, query strings, and file-page links.
 *
 * A missing safety key means "not classified" (or under the confidence
 * floor), never "clean". Nothing here infers a clean answer from absence.
 */
import type {
  ClassifierAdminWindow,
  ClassifierConfidenceBucket,
  ClassifierFlaggedFile,
  ClassifierSafetyField,
  ClassifierValueCount,
} from "./admin-api";
import { filePath } from "./public-file";

export const CLASSIFIER_WINDOWS: readonly ClassifierAdminWindow[] = [7, 30, 90];

export const CLASSIFIER_FIELDS: readonly ClassifierSafetyField[] = [
  "rating",
  "content",
  "secret",
  "pii",
];

export type FlagBadgeVariant = "destructive" | "secondary" | "outline";

/** Integer-or-one-decimal percent, "0%" when the total is zero. */
export function sharePercent(count: number, total: number): string {
  if (!(total > 0) || !(count > 0)) return "0%";
  const pct = (count / total) * 100;
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct < 0.1) return "<0.1%";
  return `${(Math.round(pct * 10) / 10).toString()}%`;
}

/** Sum of counts, the denominator for a breakdown table's share column. */
export function totalCount(rows: readonly ClassifierValueCount[]): number {
  return rows.reduce((sum, row) => sum + row.count, 0);
}

/** Rows with their share of the table total. */
export function withShares(
  rows: readonly ClassifierValueCount[],
): Array<ClassifierValueCount & { share: string }> {
  const total = totalCount(rows);
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

export function flaggedRate(stats: { answered: number; flagged: number }): string {
  return sharePercent(stats.flagged, stats.answered);
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

export interface FlaggedFilters {
  field: ClassifierSafetyField | "";
  highOnly: boolean;
  workspace: string;
  cursor?: string | null;
  limit?: number;
}

/** Query string for `/admin-ui/classifier/flagged`, empty filters omitted. */
export function flaggedQuery(filters: FlaggedFilters): string {
  const params = new URLSearchParams();
  if (filters.field) params.set("field", filters.field);
  if (filters.highOnly) params.set("confidence", "high");
  const workspace = filters.workspace.trim();
  if (workspace) params.set("workspace", workspace);
  if (filters.cursor) params.set("cursor", filters.cursor);
  if (filters.limit) params.set("limit", String(filters.limit));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function overviewQuery(days: ClassifierAdminWindow, fresh = false): string {
  const params = new URLSearchParams({ days: String(days) });
  if (fresh) params.set("fresh", "1");
  return `?${params.toString()}`;
}

/** Public file page for a flagged file; slashes kept, segments encoded. */
export function flaggedFileHref(file: Pick<ClassifierFlaggedFile, "workspace" | "key">): string {
  return filePath(file.workspace, file.key);
}

/** "5m ago", "3h ago", "2d ago"; falls back to a date past 30 days. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "-";
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 30) return `${days}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}
