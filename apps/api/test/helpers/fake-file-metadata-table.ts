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
    if (normalizedSql.startsWith("DELETE FROM file_metadata")) {
      // Whole-object delete (deleteFileMetadata).
      const [workspace, objectKey] = args as [string, string];
      this.metadata.delete(this.scopeKey(workspace, objectKey));
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
    // findObjectsByMetadata's match query: ANDed equality filters (parsed by
    // counting the repeated `(meta_key = ? AND meta_value = ?)` clause), an
    // optional prefix LIKE, and a trailing HAVING-count + LIMIT. Mirrors the
    // real SQL semantics against the in-memory store so route-level filter
    // tests exercise real wiring, not a stub.
    if (normalizedSql.startsWith("SELECT object_key FROM file_metadata WHERE workspace")) {
      const filterCount = (normalizedSql.match(/meta_key = \? AND meta_value = \?/g) ?? []).length;
      const hasPrefix = normalizedSql.includes("object_key LIKE ? || '%'");
      let idx = 0;
      const workspace = args[idx++] as string;
      const filters: Array<[string, string]> = [];
      for (let i = 0; i < filterCount; i++) {
        filters.push([args[idx] as string, args[idx + 1] as string]);
        idx += 2;
      }
      const prefix = hasPrefix ? (args[idx++] as string) : undefined;
      const requiredCount = args[idx++] as number;
      const limit = args[idx++] as number;

      const results: { object_key: string }[] = [];
      const prefixMatch = `${workspace} `;
      for (const [scopedKey, map] of this.metadata.entries()) {
        if (!scopedKey.startsWith(prefixMatch)) continue;
        const objectKey = scopedKey.slice(prefixMatch.length);
        if (prefix && !objectKey.startsWith(prefix)) continue;
        let matchCount = 0;
        for (const [key, value] of filters) {
          if (map.get(key) === value) matchCount++;
        }
        if (matchCount === requiredCount) results.push({ object_key: objectKey });
      }
      results.sort((a, b) =>
        a.object_key < b.object_key ? -1 : a.object_key > b.object_key ? 1 : 0,
      );
      return { success: true, results: results.slice(0, limit) as T[], meta: {} };
    }
    if (normalizedSql.startsWith("SELECT object_key, meta_key, meta_value FROM file_metadata")) {
      const [workspace, ...keys] = args as [string, ...string[]];
      const results: { object_key: string; meta_key: string; meta_value: string }[] = [];
      for (const key of keys) {
        const map = this.metadata.get(this.scopeKey(workspace, key));
        if (!map) continue;
        for (const [meta_key, meta_value] of map.entries()) {
          results.push({ object_key: key, meta_key, meta_value });
        }
      }
      return { success: true, results: results as T[], meta: {} };
    }
    return undefined;
  }
}
