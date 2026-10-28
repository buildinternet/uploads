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
import { contentSha256Hex } from "./provenance";
import { HOLD_MOVED_KEY } from "./upload-hold";
import { isKeyHeld } from "./upload-hold-read";
import { posterKeyFor } from "./poster";
import {
  isSharedLane,
  resolveObjectLane,
  resolveObjectLaneWithHead,
  storageConfigs,
} from "./storage";
import type { WorkspaceRecord } from "./workspace";

/** The held bucket, or `undefined` where it is not bound (tests, older deploys). */
export function heldBucket(env: Env): R2Bucket | undefined {
  const bucket = (env as { UPLOADS_HELD?: R2Bucket }).UPLOADS_HELD;
  return bucket && typeof bucket.get === "function" ? bucket : undefined;
}

export function heldObjectKey(workspaceName: string, key: string): string {
  return `${workspaceName}/${key}`;
}

/** The held keys for a file and its poster. */
function heldKeysFor(workspaceName: string, key: string): string[] {
  return [heldObjectKey(workspaceName, key), heldObjectKey(workspaceName, posterKeyFor(key))];
}

/**
 * Move `key` (and its poster) from the hosted lane into the held bucket,
 * and record `ai.hold.moved`. `false` when there is nothing to move: no held bucket, a BYO lane, or no
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
  const posterKey = posterKeyFor(key);
  const [, poster] = await Promise.all([
    copyOut(lane.store, held, heldObjectKey(workspaceName, key), key),
    lane.store.head(posterKey).catch(() => null),
  ]);
  if (poster) await copyOut(lane.store, held, heldObjectKey(workspaceName, posterKey), posterKey);
  await Promise.all([lane.store.delete(key), poster ? lane.store.delete(posterKey) : undefined]);
  await setServerFileMetadata(dbFor(env), workspaceName, key, { [HOLD_MOVED_KEY]: "1" });
  return true;
}

/**
 * Copy a held object (and its poster) back to its key on the hosted lane,
 * then drop the held copy. The return is the SHA-256 of the restored body,
 * or `null` when the held bucket has no copy.
 */
export async function restoreFromHeld(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
): Promise<string | null> {
  const held = heldBucket(env);
  if (!held) return null;
  const store = await sharedLaneStore(env, ws);
  if (!store) return null;
  const sha = await copyIn(held, store, heldObjectKey(workspaceName, key), key);
  if (!sha) return null;
  const posterKey = posterKeyFor(key);
  await copyIn(held, store, heldObjectKey(workspaceName, posterKey), posterKey);
  await held.delete(heldKeysFor(workspaceName, key));
  return sha;
}

const SHA256_RE = /^[a-f0-9]{64}$/;

/** `content-sha256` on the object, for a hold that never left the public bucket. */
export async function objectContentSha256(
  env: Env,
  ws: WorkspaceRecord,
  key: string,
): Promise<string | undefined> {
  const lane = await resolveObjectLaneWithHead(env, ws, key);
  const value = lane?.head.metadata?.["content-sha256"];
  return typeof value === "string" && SHA256_RE.test(value) ? value : undefined;
}

/**
 * Delete any held copy of `key` and its poster. With `measure`, first reads
 * the held object's size so a delete can still debit usage; otherwise it
 * skips that read and returns `null`.
 */
export async function deleteHeldCopy(
  env: Env,
  workspaceName: string,
  key: string,
  opts: { measure?: boolean } = {},
): Promise<number | null> {
  const held = heldBucket(env);
  if (!held) return null;
  const head = opts.measure ? await held.head(heldObjectKey(workspaceName, key)) : null;
  await held.delete(heldKeysFor(workspaceName, key));
  return head?.size ?? null;
}

/**
 * When `key` is held, move the object now at its public key into the held
 * bucket. For writes that land bytes under a held key without a new
 * classification: an identical re-upload, a promote, or an attach copy.
 * Pass `held` when the caller already has the key's rows.
 */
export async function reholdIfHeld(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
  held?: boolean,
): Promise<void> {
  if (!heldBucket(env)) return;
  if (!(held ?? (await isKeyHeld(env, workspaceName, key)))) return;
  await moveToHeld(env, ws, workspaceName, key);
}

/**
 * Copy a held object and its poster from `fromKey` to `toKey`. The source
 * keys stay in place so the caller can re-key D1 before deleting them.
 * `false` when the held bucket is missing or the source object is not there.
 */
export async function copyHeldObject(
  env: Env,
  workspaceName: string,
  fromKey: string,
  toKey: string,
): Promise<boolean> {
  const held = heldBucket(env);
  if (!held) return false;
  const copied = await copyHeld(
    held,
    heldObjectKey(workspaceName, fromKey),
    heldObjectKey(workspaceName, toKey),
  );
  if (!copied) return false;
  await copyHeld(
    held,
    heldObjectKey(workspaceName, posterKeyFor(fromKey)),
    heldObjectKey(workspaceName, posterKeyFor(toKey)),
  );
  return true;
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

async function copyHeld(held: R2Bucket, fromKey: string, toKey: string): Promise<boolean> {
  const source = await held.get(fromKey);
  if (!source) return false;
  const bytes = new Uint8Array(await source.arrayBuffer());
  await held.put(toKey, bytes, {
    httpMetadata: source.httpMetadata,
    customMetadata: source.customMetadata,
  });
  return true;
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
): Promise<string | null> {
  const source = await held.get(heldKey);
  if (!source) return null;
  const bytes = new Uint8Array(await source.arrayBuffer());
  await store.upload(key, bytes, {
    contentType: source.httpMetadata?.contentType ?? "application/octet-stream",
    cacheControl: UPLOAD_CACHE_CONTROL,
    metadata: { ...source.customMetadata },
  });
  return contentSha256Hex(bytes);
}
