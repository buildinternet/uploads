/**
 * Byte-side helpers for held uploads (`upload-hold.ts`). A hosted hold
 * leaves the object in the public bucket and writes `read_gate` rows. A BYO
 * hold leaves the bytes on the customer's domain: the hold still keeps the
 * file off every surface this service publishes.
 */

import type { Files } from "@uploads/storage";
import { contentHashForKey } from "./content-hash";
import { dbFor } from "./db-session";
import { insertHostedReadGate } from "./read-gate";
import { isSharedLane, resolveObjectLane, resolveObjectLaneWithHead } from "./storage";
import { isKeyHeld } from "./upload-hold-read";
import type { WorkspaceRecord } from "./workspace";

const SHA256_RE = /^[a-f0-9]{64}$/;

/**
 * The content hash a hold change should fan out on. Prefer `content-sha256`
 * on the object. When that stamp is missing, use `file_content_hash` — the
 * same column `keysCopiedFrom` reads. No object means no hash: a deleted key
 * must not release siblings from a leftover index row.
 */
export async function objectContentSha256(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
): Promise<string | undefined> {
  const lane = await resolveObjectLaneWithHead(env, ws, key);
  const value = lane?.head.metadata?.["content-sha256"];
  if (typeof value === "string" && SHA256_RE.test(value)) return value;
  if (!lane) return undefined;
  const indexed = await contentHashForKey(dbFor(env), workspaceName, key);
  return indexed && SHA256_RE.test(indexed) ? indexed : undefined;
}

/**
 * When `key` is held, write its hosted read-gate rows. For writes that land
 * bytes under a held key without a new classification: an identical
 * re-upload, a promote, or an attach copy. Pass `held` when the caller
 * already knows the key is held.
 */
export async function reholdIfHeld(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
  held?: boolean,
): Promise<void> {
  if (!(held ?? (await isKeyHeld(env, workspaceName, key)))) return;
  await insertHostedReadGate(env, dbFor(env), ws, [key]).catch((err: unknown) => {
    console.error({ event: "read_gate_insert_failed", workspace: workspaceName, err });
  });
}

/** Single-key download, so the `StoredFile` overload is inferred. */
async function downloadOne(store: Files, key: string) {
  return store.download(key);
}

/**
 * Bytes of a hosted hold for a member review, or `null`. A BYO hold
 * returns `null`. Its own domain still serves the file.
 */
export async function readPublicHold(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
): Promise<Awaited<ReturnType<typeof downloadOne>> | null> {
  if (!(await isKeyHeld(env, workspaceName, key))) return null;
  const lane = await resolveObjectLane(env, ws, key);
  if (!lane || !isSharedLane(lane.config)) return null;
  try {
    return await downloadOne(lane.store, key);
  } catch {
    return null;
  }
}
