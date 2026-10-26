/**
 * KV key metadata for `ws:<name>` records written from operator scripts (#1094).
 *
 * Mirrors `workspaceKeyMetadata` in `src/workspace-byob.ts`. It is duplicated
 * rather than imported because that module pulls in `budget.ts` and the
 * workspace-package graph, which plain `node` can't resolve. The worker test
 * `workspace-byob.test.ts` runs both over the same records to catch drift.
 *
 * `wrangler kv key put` without `--metadata` erases existing metadata, so every
 * script that rewrites a live record must pass this.
 */
export function workspaceKeyMetadata(record) {
  if (record.status === "purged" || record.deletedAt) return { byob: false };
  const customerCredentials =
    !record.binding &&
    Boolean(record.accountId || record.endpoint) &&
    Boolean(record.accessKeyId) &&
    Boolean(record.secretAccessKey);
  return { byob: customerCredentials };
}
