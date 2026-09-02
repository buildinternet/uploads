/**
 * Shared in-memory `github_attachments` table backing for route/webhook
 * tests (usage-fake-d1.ts) — mirrors the real D1 semantics (upsert on
 * (workspace, object_key), detach/reattach, chunked batch delete, rotation
 * re-key) without a full sqlite-backed D1. See
 * github-attachment-index-sqlite.test.ts for the real-SQL coverage.
 *
 * The match arms below key off the EXACT statement text in
 * src/github-attachment-index.ts, whitespace-normalized. If a statement
 * there changes, change it here too or the suite fails loudly
 * ("unsupported run: …") rather than silently dropping writes.
 */

export interface AttachmentIndexDbRow {
  workspace: string;
  repo: string;
  kind: "pull" | "issues";
  num: number;
  object_key: string;
  prefix_id: string | null;
  lane_id: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  detached_at: string | null;
}

export interface FakeRunResult {
  success: true;
  meta: { changes: number };
  results: [];
}

function key(workspace: string, objectKey: string): string {
  return `${workspace}\0${objectKey}`;
}

export class AttachmentIndexTable {
  readonly rows = new Map<string, AttachmentIndexDbRow>();

  tryRun(normalizedSql: string, args: unknown[]): FakeRunResult | undefined {
    if (normalizedSql.startsWith("INSERT INTO github_attachments")) {
      const [
        workspace,
        repo,
        kind,
        num,
        objectKey,
        prefixId,
        laneId,
        source,
        createdAt,
        updatedAt,
      ] = args as [
        string,
        string,
        "pull" | "issues",
        number,
        string,
        string | null,
        string | null,
        string,
        string,
        string,
      ];
      const k = key(workspace, objectKey);
      const existing = this.rows.get(k);
      this.rows.set(k, {
        workspace,
        repo,
        kind,
        num,
        object_key: objectKey,
        prefix_id: prefixId,
        lane_id: laneId,
        source,
        created_at: existing?.created_at ?? createdAt,
        updated_at: updatedAt,
        detached_at: null,
      });
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    if (normalizedSql.startsWith("UPDATE github_attachments SET detached_at = ?")) {
      const [detachedAt, updatedAt, workspace, objectKey] = args as [
        string,
        string,
        string,
        string,
      ];
      const row = this.rows.get(key(workspace, objectKey));
      if (!row) return { success: true, meta: { changes: 0 }, results: [] };
      row.detached_at = detachedAt;
      row.updated_at = updatedAt;
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    if (normalizedSql.startsWith("UPDATE github_attachments SET detached_at = NULL")) {
      const [updatedAt, workspace, objectKey] = args as [string, string, string];
      const row = this.rows.get(key(workspace, objectKey));
      if (!row) return { success: true, meta: { changes: 0 }, results: [] };
      row.detached_at = null;
      row.updated_at = updatedAt;
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    if (normalizedSql.startsWith("UPDATE github_attachments SET object_key = ?")) {
      const [toKey, newPrefixId, updatedAt, workspace, fromKey] = args as [
        string,
        string | null,
        string,
        string,
        string,
      ];
      const row = this.rows.get(key(workspace, fromKey));
      if (!row) return { success: true, meta: { changes: 0 }, results: [] };
      this.rows.delete(key(workspace, fromKey));
      this.rows.set(key(workspace, toKey), {
        ...row,
        object_key: toKey,
        prefix_id: newPrefixId,
        updated_at: updatedAt,
      });
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    if (normalizedSql.startsWith("DELETE FROM github_attachments")) {
      if (normalizedSql.includes("object_key IN (")) {
        const [workspace, ...keys] = args as [string, ...string[]];
        let changes = 0;
        for (const objectKey of keys) {
          if (this.rows.delete(key(workspace, objectKey))) changes++;
        }
        return { success: true, meta: { changes }, results: [] };
      }
      if (normalizedSql.includes("object_key = ?")) {
        const [workspace, objectKey] = args as [string, string];
        const changes = this.rows.delete(key(workspace, objectKey)) ? 1 : 0;
        return { success: true, meta: { changes }, results: [] };
      }
      const [workspace] = args as [string];
      let changes = 0;
      for (const [k, row] of this.rows.entries()) {
        if (row.workspace === workspace) {
          this.rows.delete(k);
          changes++;
        }
      }
      return { success: true, meta: { changes }, results: [] };
    }
    return undefined;
  }

  tryFirst<T>(normalizedSql: string, args: unknown[]): T | null | undefined {
    if (normalizedSql.includes("FROM github_attachments WHERE workspace = ? AND object_key = ?")) {
      const [workspace, objectKey] = args as [string, string];
      return (this.rows.get(key(workspace, objectKey)) as T) ?? null;
    }
    return undefined;
  }
}
