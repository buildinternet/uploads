/**
 * Shared D1 stand-in for workspace_usage (INSERT OR IGNORE + UPDATE batch)
 * and optional no-op auth_tokens lookups for route tests.
 */

import { AdoptLedgerTable } from "./helpers/fake-adopt-ledger-table";
import { BranchRenamesTable } from "./helpers/fake-branch-renames-table";
import { DeleteUsageClaimsTable } from "./helpers/fake-delete-usage-claims-table";
import { FileMetadataTable } from "./helpers/fake-file-metadata-table";
import { IngestLedgerTable } from "./helpers/fake-ingest-ledger-table";
import { PrActivityTable } from "./helpers/fake-pr-activity-table";
import { PrivatePrefixesTable } from "./helpers/fake-private-prefixes-table";
import { RepoLinksTable } from "./helpers/fake-repo-links-table";

export type UsageRow = {
  workspace: string;
  bytes: number;
  objects: number;
  shared_bytes: number;
  shared_objects: number;
  uploads_in_period: number;
  period_start: string;
  updated_at: string;
};

export class UsageFakeD1 {
  usage = new Map<string, UsageRow>();
  // Backs `file_metadata` so putObject/deleteObject's D1 metadata
  // cascade (Task 2) doesn't blow up in suites that only care about the
  // usage ledger.
  private fileMetadataTable = new FileMetadataTable();
  get fileMetadata() {
    return this.fileMetadataTable.metadata;
  }
  // Single-winner delete metering claims (issue #570).
  private deleteUsageClaimsTable = new DeleteUsageClaimsTable();
  get deleteUsageClaims() {
    return this.deleteUsageClaimsTable.claims;
  }
  // Backs `github_repo_links` for implicit-claim (comment/promote routes)
  // and webhook auto-promotion tests.
  private repoLinksTable = new RepoLinksTable();
  get repoLinks() {
    return this.repoLinksTable.rows;
  }
  // Backs `github_pr_activity` — putObject upserts a row whenever
  // gh.kind=pull metadata lands (issue #338).
  private prActivityTable = new PrActivityTable();
  get prActivity() {
    return this.prActivityTable.rows;
  }
  // Backs `github_ingested_assets` — the ingest ledger's idempotency
  // backbone (Task 2 of the GitHub attachment ingestion feature).
  private ingestLedgerTable = new IngestLedgerTable();
  get ingestLedger() {
    return this.ingestLedgerTable.rows;
  }
  // Backs `github_private_prefixes` — randomized per-branch attachment URL
  // prefixes for private repos (issue #631).
  private privatePrefixesTable = new PrivatePrefixesTable();
  get privatePrefixes() {
    return this.privatePrefixesTable.rows;
  }
  // Backs `github_adopted_links` — the link-adoption noise guard's
  // idempotency backbone (issue #709).
  private adoptLedgerTable = new AdoptLedgerTable();
  get adoptLedger() {
    return this.adoptLedgerTable.rows;
  }
  // Backs `github_branch_renames` — branch-rename aliases promote's lineage
  // sweep walks (#920).
  private branchRenamesTable = new BranchRenamesTable();
  get branchRenames() {
    return this.branchRenamesTable.rows;
  }

  prepare = (sql: string) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    let values: unknown[] = [];

    const stmt = {
      bind: (...v: unknown[]) => {
        values = v;
        return stmt;
      },
      first: async () => {
        if (normalized.includes("FROM auth_tokens")) return null;
        if (normalized.includes("FROM workspace_usage")) {
          return this.usage.get(values[0] as string) ?? null;
        }
        const linkResult = this.repoLinksTable.tryFirst(normalized, values);
        if (linkResult !== undefined) return linkResult;
        const ledgerFirstResult = this.ingestLedgerTable.tryFirst(normalized, values);
        if (ledgerFirstResult !== undefined) return ledgerFirstResult;
        const prefixFirstResult = this.privatePrefixesTable.tryFirst(normalized, values);
        if (prefixFirstResult !== undefined) return prefixFirstResult;
        const adoptFirstResult = this.adoptLedgerTable.tryFirst(normalized, values);
        if (adoptFirstResult !== undefined) return adoptFirstResult;
        throw new Error(`unsupported first: ${normalized}`);
      },
      all: async <T>() => {
        const result = this.fileMetadataTable.tryAll<T>(normalized, values);
        if (result) return result;
        const linkResult = this.repoLinksTable.tryAll<T>(normalized, values);
        if (linkResult) return linkResult;
        const activityResult = this.prActivityTable.tryAll<T>(normalized, values);
        if (activityResult) return activityResult;
        const ledgerAllResult = this.ingestLedgerTable.tryAll<T>(normalized, values);
        if (ledgerAllResult) return ledgerAllResult;
        const prefixAllResult = this.privatePrefixesTable.tryAll<T>(normalized, values);
        if (prefixAllResult) return prefixAllResult;
        const adoptAllResult = this.adoptLedgerTable.tryAll<T>(normalized, values);
        if (adoptAllResult) return adoptAllResult;
        const renameAllResult = this.branchRenamesTable.tryAll<T>(normalized, values);
        if (renameAllResult) return renameAllResult;
        // Galleries aren't modeled by this fake (route/gallery-specific tests
        // bring their own D1 stand-in) — an empty page is a safe, honest
        // default for callers (e.g. the webhook auto-promote gather) that
        // only care that "no galleries" doesn't blow up.
        if (normalized.includes("FROM galleries") || normalized.includes("gallery_")) {
          return { success: true as const, results: [] as T[], meta: {} };
        }
        throw new Error(`unsupported all: ${normalized}`);
      },
      run: async () => {
        const metaResult = this.fileMetadataTable.tryRun(normalized, values);
        if (metaResult) return metaResult;
        const linkResult = this.repoLinksTable.tryRun(normalized, values);
        if (linkResult) return linkResult;
        const activityResult = this.prActivityTable.tryRun(normalized, values);
        if (activityResult) return activityResult;
        const ledgerRunResult = this.ingestLedgerTable.tryRun(normalized, values);
        if (ledgerRunResult) return ledgerRunResult;
        const prefixRunResult = this.privatePrefixesTable.tryRun(normalized, values);
        if (prefixRunResult) return prefixRunResult;
        const adoptRunResult = this.adoptLedgerTable.tryRun(normalized, values);
        if (adoptRunResult) return adoptRunResult;
        const renameRunResult = this.branchRenamesTable.tryRun(normalized, values);
        if (renameRunResult) return renameRunResult;
        const claimResult = this.deleteUsageClaimsTable.tryRun(normalized, values);
        if (claimResult) return claimResult;
        if (normalized.startsWith("INSERT OR IGNORE INTO workspace_usage")) {
          // applyUsageDelta: (ws, period, updatedAt) with zeros
          // setUsageTotals: (ws, bytes, objects, period, updatedAt)
          if (values.length === 3) {
            const [workspace, period, updatedAt] = values as [string, string, string];
            if (!this.usage.has(workspace)) {
              this.usage.set(workspace, {
                workspace,
                bytes: 0,
                objects: 0,
                shared_bytes: 0,
                shared_objects: 0,
                uploads_in_period: 0,
                period_start: period,
                updated_at: updatedAt,
              });
            }
          } else {
            const [workspace, bytes, objects, sharedBytes, sharedObjects, period, updatedAt] =
              values as [string, number, number, number, number, string, string];
            if (!this.usage.has(workspace)) {
              this.usage.set(workspace, {
                workspace,
                bytes,
                objects,
                shared_bytes: sharedBytes,
                shared_objects: sharedObjects,
                uploads_in_period: 0,
                period_start: period,
                updated_at: updatedAt,
              });
            }
          }
          return { success: true as const, meta: { changes: 1 }, results: [] };
        }
        if (normalized.startsWith("UPDATE workspace_usage SET")) {
          // Guarded storage reservation from reserveStorageBytes (check before
          // the upload-count path — both contain `<= ?`).
          if (normalized.includes("bytes + ? <=") || normalized.includes("shared_bytes + ? <=")) {
            const [deltaBytes, sharedDeltaBytes, updatedAt, workspace, enforcedDelta, max] =
              values as [number, number, string, string, number, number];
            const row = this.usage.get(workspace);
            if (!row) throw new Error(`update before insert for ${workspace}`);
            const enforcedBytes = normalized.includes("shared_bytes + ? <=")
              ? row.shared_bytes
              : row.bytes;
            if (enforcedBytes + enforcedDelta > max) {
              return { success: true as const, meta: { changes: 0 }, results: [] };
            }
            this.usage.set(workspace, {
              ...row,
              bytes: row.bytes + deltaBytes,
              shared_bytes: row.shared_bytes + sharedDeltaBytes,
              updated_at: updatedAt,
            });
            return { success: true as const, meta: { changes: 1 }, results: [] };
          }
          // Storage release from releaseStorageBytesSafe.
          if (normalized.includes("MAX(0, bytes - ?)")) {
            const [reservedBytes, sharedReservedBytes, updatedAt, workspace] = values as [
              number,
              number,
              string,
              string,
            ];
            const row = this.usage.get(workspace);
            if (!row) return { success: true as const, meta: { changes: 0 }, results: [] };
            this.usage.set(workspace, {
              ...row,
              bytes: Math.max(0, row.bytes - reservedBytes),
              shared_bytes: Math.max(0, row.shared_bytes - sharedReservedBytes),
              updated_at: updatedAt,
            });
            return { success: true as const, meta: { changes: 1 }, results: [] };
          }
          // Guarded reservation from reserveUploads: increments
          // uploads_in_period only while within the cap; changes: 0 signals
          // a spent budget. Atomic within a single run(), like D1's UPDATE.
          if (normalized.includes("<= ?")) {
            const [period, count, periodSet, updatedAt, workspace, , , max] = values as [
              string,
              number,
              string,
              string,
              string,
              string,
              number,
              number,
            ];
            const row = this.usage.get(workspace);
            if (!row) throw new Error(`update before insert for ${workspace}`);
            const current = row.period_start === period ? row.uploads_in_period : 0;
            if (current + count > max) {
              return { success: true as const, meta: { changes: 0 }, results: [] };
            }
            this.usage.set(workspace, {
              ...row,
              uploads_in_period: current + count,
              period_start: periodSet,
              updated_at: updatedAt,
            });
            return { success: true as const, meta: { changes: 1 }, results: [] };
          }
          // Reservation release from releaseUploadsSafe: same-period
          // decrement clamped at zero; a rolled-over period is a no-op.
          if (normalized.includes("MAX(0, uploads_in_period - ?)")) {
            const [period, count, updatedAt, workspace] = values as [
              string,
              number,
              string,
              string,
            ];
            const row = this.usage.get(workspace);
            if (!row) return { success: true as const, meta: { changes: 0 }, results: [] };
            this.usage.set(workspace, {
              ...row,
              uploads_in_period:
                row.period_start === period
                  ? Math.max(0, row.uploads_in_period - count)
                  : row.uploads_in_period,
              updated_at: updatedAt,
            });
            return { success: true as const, meta: { changes: 1 }, results: [] };
          }
          // Absolute totals from setUsageTotals: bytes, objects, updated_at, workspace
          if (
            normalized.includes("bytes = ?") &&
            normalized.includes("objects = ?") &&
            !normalized.includes("bytes +")
          ) {
            const [bytes, objects, sharedBytes, sharedObjects, updatedAt, workspace] = values as [
              number,
              number,
              number,
              number,
              string,
              string,
            ];
            const row = this.usage.get(workspace);
            if (!row) throw new Error(`update before insert for ${workspace}`);
            this.usage.set(workspace, {
              ...row,
              bytes,
              objects,
              shared_bytes: sharedBytes,
              shared_objects: sharedObjects,
              updated_at: updatedAt,
            });
            return { success: true as const, meta: { changes: 1 }, results: [] };
          }
          // Delta apply from applyUsageDelta
          const [
            dBytes,
            dObjects,
            dSharedBytes,
            dSharedObjects,
            period,
            dUploadsAdd,
            dUploadsNew,
            periodSet,
            updatedAt,
            workspace,
          ] = values as [
            number,
            number,
            number,
            number,
            string,
            number,
            number,
            string,
            string,
            string,
          ];
          const row = this.usage.get(workspace);
          if (!row) throw new Error(`update before insert for ${workspace}`);
          const samePeriod = row.period_start === period;
          this.usage.set(workspace, {
            workspace,
            bytes: Math.max(0, row.bytes + dBytes),
            objects: Math.max(0, row.objects + dObjects),
            shared_bytes: Math.max(0, row.shared_bytes + dSharedBytes),
            shared_objects: Math.max(0, row.shared_objects + dSharedObjects),
            uploads_in_period: samePeriod
              ? row.uploads_in_period + dUploadsAdd
              : Math.max(0, dUploadsNew),
            period_start: periodSet,
            updated_at: updatedAt,
          });
          return { success: true as const, meta: { changes: 1 }, results: [] };
        }
        if (normalized.startsWith("UPDATE auth_tokens SET last_used_at")) {
          return { success: true as const, meta: { changes: 1 }, results: [] };
        }
        throw new Error(`unsupported run: ${normalized}`);
      },
    };
    return stmt;
  };

  batch = async (statements: { run: () => Promise<unknown> }[]) => {
    const results = [];
    for (const stmt of statements) results.push(await stmt.run());
    return results;
  };

  /** D1 Sessions API stub (see src/db-session.ts) — this fake has no
   *  primary/replica split, so a "session" is just itself. */
  withSession = () => this;
}
