/**
 * A promote or attach copy is not classified again. The destination keeps
 * the source's classifier rows, and `ai.copied-from` names the source so a
 * hold that lands later can find the copy. When the source is already held,
 * the copy is gated in this call.
 */

import { dbFor } from "./db-session";
import { classifierRowsOf, copyLineageMeta, setServerFileMetadata } from "./file-metadata";
import { reholdIfHeld } from "./held-storage";
import { HOLD_META_KEY, HOLD_PENDING } from "./upload-hold";
import { isKeyHeld } from "./upload-hold-read";
import type { WorkspaceRecord } from "./workspace";

export async function carryHoldToCopy(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  sourceKey: string,
  destKey: string,
  sourceMeta: Record<string, string> | undefined,
): Promise<void> {
  const db = dbFor(env);
  await setServerFileMetadata(db, workspaceName, destKey, {
    ...classifierRowsOf(sourceMeta),
    ...copyLineageMeta(sourceKey),
  });
  if (await isKeyHeld(env, workspaceName, destKey)) {
    await reholdIfHeld(env, ws, workspaceName, destKey, true);
    return;
  }
  // The caller may have snapshotted the source before the hold landed.
  if (!(await isKeyHeld(env, workspaceName, sourceKey))) return;
  await setServerFileMetadata(db, workspaceName, destKey, { [HOLD_META_KEY]: HOLD_PENDING });
  await reholdIfHeld(env, ws, workspaceName, destKey, true);
}
