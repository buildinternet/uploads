/**
 * Re-seal BYO credentials in REGISTRY under the current WORKSPACE_SECRETS_KEY.
 * Decrypt uses current + previous; encrypt uses current only.
 * Intended for POST /admin/credentials/reencrypt (admin-gated) — not a laptop
 * script holding the KEK in the shell.
 */
import { resealCredentialFields, secretsKeyRingFromEnv, type SecretsKeyRing } from "./secrets";
import type { WorkspaceRecord } from "./workspace";

export interface ReencryptResult {
  dryRun: boolean;
  scanned: number;
  updated: number;
  skipped: number;
  errors: Array<{ workspace: string; error: string }>;
  workspaces: Array<{
    workspace: string;
    action: "updated" | "would_update" | "skipped";
    reason?: string;
  }>;
}

export async function reencryptRegistryCredentials(
  env: Env,
  opts: { dryRun?: boolean } = {},
): Promise<ReencryptResult> {
  const dryRun = opts.dryRun === true;
  const ring: SecretsKeyRing = secretsKeyRingFromEnv(env);
  if (!ring.current || ring.current.length < 16) {
    throw new Error("WORKSPACE_SECRETS_KEY must be configured on the worker");
  }

  let cursor: string | undefined;
  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  const errors: ReencryptResult["errors"] = [];
  const workspaces: ReencryptResult["workspaces"] = [];

  do {
    const page = await env.REGISTRY.list({ prefix: "ws:", cursor, limit: 100 });
    for (const entry of page.keys) {
      scanned += 1;
      const name = entry.name.startsWith("ws:") ? entry.name.slice(3) : entry.name;
      if (!name) continue;

      let record: WorkspaceRecord | null;
      try {
        record = await env.REGISTRY.get<WorkspaceRecord>(entry.name, "json");
      } catch (err) {
        errors.push({
          workspace: name,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (!record) {
        skipped += 1;
        workspaces.push({ workspace: name, action: "skipped", reason: "missing" });
        continue;
      }
      if (!record.accessKeyId && !record.secretAccessKey) {
        skipped += 1;
        workspaces.push({ workspace: name, action: "skipped", reason: "no_credentials" });
        continue;
      }

      try {
        const resealed = await resealCredentialFields(ring, {
          accessKeyId: record.accessKeyId,
          secretAccessKey: record.secretAccessKey,
        });
        if (!resealed.changed) {
          skipped += 1;
          workspaces.push({ workspace: name, action: "skipped", reason: "already_current" });
          continue;
        }
        if (!dryRun) {
          const next: WorkspaceRecord = {
            ...record,
            accessKeyId: resealed.accessKeyId,
            secretAccessKey: resealed.secretAccessKey,
          };
          await env.REGISTRY.put(entry.name, JSON.stringify(next));
        }
        updated += 1;
        workspaces.push({
          workspace: name,
          action: dryRun ? "would_update" : "updated",
        });
      } catch (err) {
        errors.push({
          workspace: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  console.log(
    JSON.stringify({
      message: "credentials_reencrypt",
      dryRun,
      scanned,
      updated,
      skipped,
      errorCount: errors.length,
    }),
  );

  return { dryRun, scanned, updated, skipped, errors, workspaces };
}
