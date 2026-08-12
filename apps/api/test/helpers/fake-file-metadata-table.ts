/**
 * Shared in-memory `file_metadata` table backing for apps/api route tests
 * (routes-files.test.ts, routes-public-files.test.ts, usage-fake-d1.ts), so
 * putObject/deleteObject/setFileMetadata/findObjectsByMetadata's D1 reads and
 * writes behave for real without a full sqlite-backed D1 (see
 * file-metadata-sqlite.test.ts for that). Each caller's fake D1 `prepare()`
 * tries `tryRun`/`tryAll` first and falls back to its own auth_tokens /
 * workspace_usage logic for everything else.
 */

export interface MetaRow {
  meta_key: string;
  meta_value: string;
}

export interface FakeRunResult {
  success: true;
  meta: { changes: number };
  results: [];
}

export interface FakeAllResult<T> {
  success: true;
  results: T[];
  meta: Record<string, unknown>;
}

export class FileMetadataTable {
  /** Keyed by `${workspace} ${objectKey}` -> ordered meta_key -> meta_value. */
  readonly metadata = new Map<string, Map<string, string>>();

  private scopeKey(workspace: string, objectKey: string): string {
    return `${workspace} ${objectKey}`;
  }

  /** Handles the write-side (INSERT/DELETE) statements targeting file_metadata, else undefined. */
  tryRun(normalizedSql: string, args: unknown[]): FakeRunResult | undefined {
    if (normalizedSql.startsWith("INSERT INTO file_metadata")) {
      const [workspace, objectKey, key, value] = args as [string, string, string, string];
      const scope = this.scopeKey(workspace, objectKey);
      const map = this.metadata.get(scope) ?? new Map<string, string>();
      map.set(key, value);
      this.metadata.set(scope, map);
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    if (
      normalizedSql.startsWith("DELETE FROM file_metadata") &&
      normalizedSql.includes("meta_key = ?")
    ) {
      // Single-key delete (setFileMetadata's `remove` path).
      const [workspace, objectKey, key] = args as [string, string, string];
      this.metadata.get(this.scopeKey(workspace, objectKey))?.delete(key);
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    if (
      normalizedSql.startsWith("DELETE FROM file_metadata") &&
      normalizedSql.includes("meta_key IN (")
    ) {
      // Named-keys delete (deleteServerFileMetadataKeys) — only the listed
      // keys, never the whole object's row set.
      const [workspace, objectKey, ...keys] = args as [string, string, ...string[]];
      const map = this.metadata.get(this.scopeKey(workspace, objectKey));
      if (map) for (const key of keys) map.delete(key);
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    if (normalizedSql.startsWith("DELETE FROM file_metadata")) {
      // Whole-object delete (deleteFileMetadata).
      const [workspace, objectKey] = args as [string, string];
      this.metadata.delete(this.scopeKey(workspace, objectKey));
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    if (normalizedSql.startsWith("UPDATE file_metadata SET object_key = ?")) {
      // Rotation's rename-in-place (issue #631, Task 8): move every
      // meta_key row from the old object_key scope to the new one, keeping
      // their values, so the metadata "follows" the key across the rename.
      const [newObjectKey, workspace, oldObjectKey] = args as [string, string, string];
      const oldScope = this.scopeKey(workspace, oldObjectKey);
      const map = this.metadata.get(oldScope);
      if (map) {
        this.metadata.set(this.scopeKey(workspace, newObjectKey), map);
        this.metadata.delete(oldScope);
      }
      return { success: true, meta: { changes: map ? map.size : 0 }, results: [] };
    }
    if (normalizedSql.startsWith("UPDATE file_metadata SET meta_value = ?")) {
      // updateFileMetadataValue: targeted single-key flip (e.g. gh.detached),
      // no-op if the key isn't already present.
      const [value, , workspace, objectKey, metaKey] = args as [
        string,
        string,
        string,
        string,
        string,
      ];
      const map = this.metadata.get(this.scopeKey(workspace, objectKey));
      if (!map || !map.has(metaKey)) {
        return { success: true, meta: { changes: 0 }, results: [] };
      }
      map.set(metaKey, value);
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    return undefined;
  }

  /** Handles the read-side (SELECT) statements targeting file_metadata, else undefined. */
  tryAll<T>(normalizedSql: string, args: unknown[]): FakeAllResult<T> | undefined {
    if (normalizedSql.startsWith("SELECT meta_key, meta_value FROM file_metadata")) {
      const [workspace, objectKey] = args as [string, string];
      const map =
        this.metadata.get(this.scopeKey(workspace, objectKey)) ?? new Map<string, string>();
      const results = [...map.entries()].map(
        ([meta_key, meta_value]) => ({ meta_key, meta_value }) as MetaRow,
      );
      return { success: true, results: results as T[], meta: {} };
    }
    // findObjectsByMetadata: single equality, or multi-filter INTERSECT legs.
    // Args: (workspace, key, value)×N, optional LIKE-escaped prefix, limit.
    if (
      normalizedSql.startsWith("SELECT object_key FROM file_metadata WHERE workspace") ||
      normalizedSql.startsWith("SELECT object_key FROM (SELECT object_key FROM file_metadata")
    ) {
      const filterCount = (normalizedSql.match(/meta_key = \? AND meta_value = \?/g) ?? []).length;
      const hasPrefix = normalizedSql.includes("object_key LIKE ? || '%'");
      const filters: Array<{ workspace: string; key: string; value: string }> = [];
      for (let i = 0; i < filterCount; i++) {
        const base = i * 3;
        filters.push({
          workspace: args[base] as string,
          key: args[base + 1] as string,
          value: args[base + 2] as string,
        });
      }
      let idx = filterCount * 3;
      // Bound prefix is ESCAPE-quoted for SQL LIKE; strip escapes for startsWith.
      const prefix = hasPrefix ? String(args[idx++]).replace(/\\([\\%_])/g, "$1") : undefined;
      const limit = args[idx] as number;
      const workspace = filters[0]?.workspace;
      if (!workspace || filters.some((f) => f.workspace !== workspace)) {
        return { success: true, results: [] as T[], meta: {} };
      }

      const results: { object_key: string }[] = [];
      const scopePrefix = `${workspace} `;
      for (const [scopedKey, map] of this.metadata) {
        if (!scopedKey.startsWith(scopePrefix)) continue;
        const objectKey = scopedKey.slice(scopePrefix.length);
        if (prefix && !objectKey.startsWith(prefix)) continue;
        if (filters.every((f) => map.get(f.key) === f.value)) {
          results.push({ object_key: objectKey });
        }
      }
      results.sort((a, b) => a.object_key.localeCompare(b.object_key));
      return { success: true, results: results.slice(0, limit) as T[], meta: {} };
    }
    if (normalizedSql.startsWith("SELECT object_key, meta_key, meta_value FROM file_metadata")) {
      // getMetadataForKeys binds (workspace, ...objectKeys, ...metaKeys). The
      // trailing meta-key filter (issue #365) is optional, so split the args by
      // how many `?` placeholders the IN-filter actually carries.
      const metaKeyCount = (normalizedSql.match(/AND meta_key IN \(([^)]*)\)/)?.[1] ?? "")
        .split(",")
        .filter((placeholder) => placeholder.trim() === "?").length;
      const [workspace, ...rest] = args as [string, ...string[]];
      const keys = metaKeyCount > 0 ? rest.slice(0, -metaKeyCount) : rest;
      const wanted = metaKeyCount > 0 ? new Set(rest.slice(-metaKeyCount)) : undefined;
      const results: { object_key: string; meta_key: string; meta_value: string }[] = [];
      for (const key of keys) {
        const map = this.metadata.get(this.scopeKey(workspace, key));
        if (!map) continue;
        for (const [meta_key, meta_value] of map.entries()) {
          if (wanted && !wanted.has(meta_key)) continue;
          results.push({ object_key: key, meta_key, meta_value });
        }
      }
      return { success: true, results: results as T[], meta: {} };
    }
    // facetKeys: distinct meta keys with counts (issue #528).
    if (
      normalizedSql.startsWith(
        "SELECT meta_key, COUNT(*) AS count, COUNT(DISTINCT meta_value) AS distinct_values",
      )
    ) {
      const [workspace, limit] = args as [string, number];
      const scopePrefix = `${workspace} `;
      const byKey = new Map<string, { count: number; values: Set<string> }>();
      for (const [scopedKey, map] of this.metadata) {
        if (!scopedKey.startsWith(scopePrefix)) continue;
        for (const [meta_key, meta_value] of map.entries()) {
          // Mirror EXCLUDE_SERVER_KEYS (video.* today).
          if (meta_key.startsWith("video.")) continue;
          const entry = byKey.get(meta_key) ?? { count: 0, values: new Set<string>() };
          entry.count += 1;
          entry.values.add(meta_value);
          byKey.set(meta_key, entry);
        }
      }
      const results = [...byKey.entries()]
        .map(([meta_key, entry]) => ({
          meta_key,
          count: entry.count,
          distinct_values: entry.values.size,
        }))
        .sort((a, b) => b.count - a.count || a.meta_key.localeCompare(b.meta_key))
        .slice(0, limit);
      return { success: true, results: results as T[], meta: {} };
    }
    // facetValues: distinct values for one meta key (issue #528).
    if (normalizedSql.startsWith("SELECT meta_value, COUNT(*) AS count FROM file_metadata")) {
      const [workspace, key, limit] = args as [string, string, number];
      const scopePrefix = `${workspace} `;
      const counts = new Map<string, number>();
      for (const [scopedKey, map] of this.metadata) {
        if (!scopedKey.startsWith(scopePrefix)) continue;
        const value = map.get(key);
        if (value === undefined) continue;
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
      const results = [...counts.entries()]
        .map(([meta_value, count]) => ({ meta_value, count }))
        .sort((a, b) => b.count - a.count || a.meta_value.localeCompare(b.meta_value))
        .slice(0, limit);
      return { success: true, results: results as T[], meta: {} };
    }
    return undefined;
  }
}
