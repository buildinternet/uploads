/**
 * Where a held upload's bytes wait (`upload-hold.ts`). The storage hosts are
 * R2 custom domains with no Worker in the read path, so the only way to stop
 * a public URL serving a held file is to take the object out of the public
 * bucket. A hold copies it into `UPLOADS_HELD`, a bucket with no public
 * domain, at `<workspace>/<key>`, then deletes the public key. Approval
 * copies it back to the same key, so links work again.
 *
 * Hosted (shared-lane) objects only. A BYO bucket is served from the
 * customer's own domain, and its bytes stay where they are: the hold still
 * keeps the file off every surface this service publishes.
 *
 * A derived poster (video, PDF) moves with its file.
 */

import { createStorage, type Files } from "@uploads/storage";
import { dbFor } from "./db-session";
import { setServerFileMetadata } from "./file-metadata";
import { UPLOAD_CACHE_CONTROL } from "./files-core";
import { HOLD_MOVED_KEY } from "./upload-hold";
import { heldKeysAmong } from "./upload-hold-read";
import { posterKeyFor } from "./poster";
import { isSharedLane, resolveObjectLane, storageConfigs } from "./storage";
import type { WorkspaceRecord } from "./workspace";

/** The held bucket, or `undefined` where it is not bound (tests, older deploys). */
export function heldBucket(env: Env): R2Bucket | undefined {
  const bucket = (env as { UPLOADS_HELD?: R2Bucket }).UPLOADS_HELD;
  return bucket && typeof bucket.get === "function" ? bucket : undefined;
}

export function heldObjectKey(workspaceName: string, key: string): string {
  return `${workspaceName}/${key}`;
}

/**
 * Move `key` (and its poster) from the hosted lane into the held bucket.
 * `false` when there is nothing to move: no held bucket, a BYO lane, or no
 * object. The copy lands before the public delete, so a failure part way
 * leaves the public object in place rather than losing it.
 */
export async function moveToHeld(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
): Promise<boolean> {
  const held = heldBucket(env);
  if (!held) return false;
  const lane = await resolveObjectLane(env, ws, key);
  if (!lane || !isSharedLane(lane.config)) return false;
  await copyOut(lane.store, held, heldObjectKey(workspaceName, key), key);
  const posterKey = posterKeyFor(key);
  if (await lane.store.head(posterKey).catch(() => null)) {
    await copyOut(lane.store, held, heldObjectKey(workspaceName, posterKey), posterKey);
    await lane.store.delete(posterKey);
  }
  await lane.store.delete(key);
  return true;
}

/**
 * Copy a held object (and its poster) back to its key on the hosted lane,
 * then drop the held copy. `false` when the held bucket has no copy.
 */
export async function restoreFromHeld(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
): Promise<boolean> {
  const held = heldBucket(env);
  if (!held) return false;
  const store = await sharedLaneStore(env, ws);
  if (!store) return false;
  const restored = await copyIn(held, store, heldObjectKey(workspaceName, key), key);
  if (!restored) return false;
  const posterKey = posterKeyFor(key);
  await copyIn(held, store, heldObjectKey(workspaceName, posterKey), posterKey);
  await held.delete([heldObjectKey(workspaceName, key), heldObjectKey(workspaceName, posterKey)]);
  return true;
}

/**
 * Delete any held copy of `key` and its poster. Returns the held object's
 * size so a delete can still debit usage, or `null` when there was none.
 */
export async function deleteHeldCopy(
  env: Env,
  workspaceName: string,
  key: string,
): Promise<number | null> {
  const held = heldBucket(env);
  if (!held) return null;
  const heldKey = heldObjectKey(workspaceName, key);
  const head = await held.head(heldKey);
  await held.delete([heldKey, heldObjectKey(workspaceName, posterKeyFor(key))]);
  return head?.size ?? null;
}

/**
 * When `key` is held, move the object now at its public key into the held
 * bucket. For writes that land bytes under a held key without a new
 * classification: an identical re-upload, a promote, or an attach copy.
 */
export async function reholdIfHeld(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
): Promise<void> {
  if (!heldBucket(env)) return;
  if (!(await heldKeysAmong(env, workspaceName, [key])).has(key)) return;
  if (await moveToHeld(env, ws, workspaceName, key)) {
    await setServerFileMetadata(dbFor(env), workspaceName, key, { [HOLD_MOVED_KEY]: "1" });
  }
}

/** Drop any held copy of `key` and its poster, without reading it first. */
export async function dropHeldCopy(env: Env, workspaceName: string, key: string): Promise<void> {
  const held = heldBucket(env);
  if (!held) return;
  await held.delete([
    heldObjectKey(workspaceName, key),
    heldObjectKey(workspaceName, posterKeyFor(key)),
  ]);
}

/** A held object's body for a member review, or `null`. */
export async function readHeld(
  env: Env,
  workspaceName: string,
  key: string,
): Promise<R2ObjectBody | null> {
  const held = heldBucket(env);
  if (!held) return null;
  return held.get(heldObjectKey(workspaceName, key));
}

async function sharedLaneStore(env: Env, ws: WorkspaceRecord): Promise<Files | null> {
  const configs = await storageConfigs(env, ws);
  const shared = configs.find((lane) => isSharedLane(lane.config));
  return shared ? createStorage(shared.config) : null;
}

async function copyOut(store: Files, held: R2Bucket, heldKey: string, key: string): Promise<void> {
  const source = await store.download(key);
  const bytes = new Uint8Array(await source.arrayBuffer());
  await held.put(heldKey, bytes, {
    httpMetadata: { contentType: source.type },
    customMetadata: { ...source.metadata },
  });
}

async function copyIn(
  held: R2Bucket,
  store: Files,
  heldKey: string,
  key: string,
): Promise<boolean> {
  const source = await held.get(heldKey);
  if (!source) return false;
  const bytes = new Uint8Array(await source.arrayBuffer());
  await store.upload(key, bytes, {
    contentType: source.httpMetadata?.contentType ?? "application/octet-stream",
    cacheControl: UPLOAD_CACHE_CONTROL,
    metadata: { ...source.customMetadata },
  });
  return true;
}
