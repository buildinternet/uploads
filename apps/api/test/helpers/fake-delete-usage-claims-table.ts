/**
 * In-memory `delete_usage_claims` (issue #570) for route/files-core fakes.
 * Mirrors D1 `INSERT OR IGNORE` first-wins and clear-on-re-put semantics.
 */

export interface FakeRunResult {
  success: true;
  meta: { changes: number };
  results: [];
}

export class DeleteUsageClaimsTable {
  /** Key is `workspace\\0object_key` → claimed_at. */
  readonly claims = new Map<string, string>();

  tryRun(normalizedSql: string, args: unknown[]): FakeRunResult | undefined {
    if (normalizedSql.startsWith("INSERT OR IGNORE INTO delete_usage_claims")) {
      const [workspace, objectKey, claimedAt] = args as [string, string, string];
      const claimKey = `${workspace}\0${objectKey}`;
      if (this.claims.has(claimKey)) {
        return { success: true, meta: { changes: 0 }, results: [] };
      }
      this.claims.set(claimKey, claimedAt);
      return { success: true, meta: { changes: 1 }, results: [] };
    }
    if (normalizedSql.startsWith("DELETE FROM delete_usage_claims")) {
      const [workspace, objectKey] = args as [string, string];
      const claimKey = `${workspace}\0${objectKey}`;
      const existed = this.claims.delete(claimKey);
      return { success: true, meta: { changes: existed ? 1 : 0 }, results: [] };
    }
    return undefined;
  }
}
