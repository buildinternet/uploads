/**
 * Health state for the active BYO (customer-credential) storage lane — issue
 * #826.
 *
 * Verification (`storage-verify.ts`) is a point-in-time stamp: it runs at
 * connect, at rotate, and before a stale lane is activated. Nothing between
 * those moments notices when a previously-working R2 token is revoked, the
 * bucket is deleted, or the account is detached — the workspace just starts
 * failing uploads. This module closes that gap from the cheapest possible
 * signal: the storage operations the workspace is *already* running. When a
 * write fails with an auth-shaped error, the active lane is flagged unhealthy
 * on the workspace record; when one succeeds again, the flag clears itself.
 *
 * Deliberately not a scheduled prober. A cron sweep would cost a live
 * round-trip against every BYO bucket on a fixed interval whether or not the
 * workspace is being used, and it would still learn nothing sooner than the
 * first failing upload does for an active workspace. Detection here is free
 * and exactly as timely; a sweep can be added later for idle workspaces
 * without changing any of the state this module writes.
 *
 * Every write goes through `mutateWorkspaceRecord` (never a bare
 * `REGISTRY.put`) and is a no-op unless it would actually change the record,
 * so the common path — healthy lane, successful upload — costs zero KV
 * writes.
 *
 * Never put a credential value, or any part of one, into a code, message, or
 * log line here.
 */
import { storageBudgetApplies } from "./budget";
import { mutateWorkspaceRecord } from "./workspace-mutate";
import type { WorkspaceRecord } from "./workspace";

/**
 * True for customer-credential (BYO) storage. Identical to
 * `isByoRecord` in `routes/workspace-storage.ts` and derived from the same
 * single source (`storageBudgetApplies`, which returns `false` for exactly
 * this shape) rather than importing it — that module imports *this* one for
 * `storageHealth`, and routing a core detection path through a route module
 * to save four lines is not worth the import cycle.
 */
function isByoRecord(
  record: Pick<
    WorkspaceRecord,
    "binding" | "accountId" | "accessKeyId" | "secretAccessKey" | "endpoint"
  >,
): boolean {
  return !storageBudgetApplies(record);
}

/**
 * Why the active lane is considered unhealthy. Deliberately coarse — these
 * map 1:1 onto the three sentences a workspace admin can actually act on,
 * not onto the underlying S3 error taxonomy.
 */
export type StorageHealthCode = "auth" | "bucket_missing" | "unreachable";

/**
 * Plain-language failure sentences, in the same voice as the verify-form
 * failures on the storage settings page (`STORAGE_CHECK_FAILURES`): what went
 * wrong, not which probe stage reported it. The fix is always the same one
 * (rotate credentials), so it is not repeated in the sentence — the UI puts
 * it on the button.
 */
export const STORAGE_HEALTH_MESSAGES: Record<StorageHealthCode, string> = {
  auth: "We can no longer sign in to your bucket",
  bucket_missing: "We can no longer find your bucket",
  unreachable: "We can no longer reach your bucket",
};

/** Duck-types files-sdk's `FilesError` without depending on the package (apps/api doesn't declare it) — same shape check `storage-verify.ts` uses. */
function errorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** HTTP status carried by a files-sdk error, when it carries one. */
function errorStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/**
 * Maps a storage-operation failure onto a health code, or `undefined` when
 * the failure says nothing about the lane's credentials.
 *
 * Only *credential-shaped* failures flag a lane. A 4xx the caller caused
 * (a too-large object, a bad key) and a transient 5xx both return
 * `undefined`: flagging on those would light the banner for problems a
 * credential rotation cannot fix, which is worse than saying nothing.
 *
 * Note what is deliberately absent. files-sdk normalizes network blips,
 * connection timeouts, and provider outages to a single `Provider` code, and
 * retries them itself as transient. Nothing in that shape separates "this
 * bucket is gone for good" from "the network hiccuped". So this function
 * never returns `unreachable`: a transport failure leaves the lane unflagged
 * rather than telling a workspace to rotate keys that are probably fine.
 * `unreachable` exists only as `healthCodeOf`'s fallback wording for a stored
 * code this version does not recognize.
 */
export function classifyStorageFailure(err: unknown): StorageHealthCode | undefined {
  const code = errorCode(err);
  if (code === "Unauthorized" || code === "Forbidden") return "auth";
  if (code === "NotFound") return "bucket_missing";
  const status = errorStatus(err);
  if (status === 401 || status === 403) return "auth";
  return undefined;
}

/** The active lane's health, projected for the settings page and the signed-in banner. */
export interface StorageHealth {
  ok: boolean;
  /** Present only when `ok` is false. */
  code?: StorageHealthCode;
  /** Plain-language sentence for `code`. Present only when `ok` is false. */
  message?: string;
  /** When the lane was first flagged (not the most recent failure) — "failing since". */
  since?: string;
}

const HEALTH_CODES = new Set<string>(["auth", "bucket_missing", "unreachable"]);

function healthCodeOf(code: string | undefined): StorageHealthCode {
  // A record hand-edited (or written by a future version) with an unknown
  // code still reports *unhealthy* — the flag is the signal, the code only
  // picks the sentence. Falling back to `unreachable` keeps the vaguest,
  // least-wrong wording.
  return code && HEALTH_CODES.has(code) ? (code as StorageHealthCode) : "unreachable";
}

/**
 * Normalizes a stored (timestamp, code) pair into the projected shape. The
 * single place a stored code becomes a validated code plus its sentence, so
 * the active lane and the saved-lane list can never disagree about what a
 * given stored value means.
 */
export function healthFromFields(at: string | undefined, code: string | undefined): StorageHealth {
  if (!at) return { ok: true };
  const validated = healthCodeOf(code);
  return {
    ok: false,
    code: validated,
    message: STORAGE_HEALTH_MESSAGES[validated],
    since: at,
  };
}

/** Reads the *active* lane's flag into the projected shape. Healthy when nothing is flagged. */
export function storageHealth(
  record: Pick<WorkspaceRecord, "storageUnhealthyAt" | "storageUnhealthyCode">,
): StorageHealth {
  return healthFromFields(record.storageUnhealthyAt, record.storageUnhealthyCode);
}

/**
 * Clears the health flag on `next` in place. Called from every path that has
 * just *proven* the active lane works — a successful rotate, a successful
 * activate — so a fixed lane never keeps a stale danger badge until its next
 * upload happens to land.
 */
export function clearStorageHealthFields(next: WorkspaceRecord): void {
  delete next.storageUnhealthyAt;
  delete next.storageUnhealthyCode;
}

/**
 * Flags the workspace's active lane unhealthy after a failed storage
 * operation. Safe to call on any failure — it filters down to the cases
 * worth reporting itself:
 *
 * - non-credential errors (`classifyStorageFailure` → `undefined`) are ignored;
 * - shared (platform binding) lanes are ignored: a shared-lane failure is our
 *   problem, and telling a workspace to rotate credentials it doesn't own
 *   would be nonsense;
 * - a lane already flagged with the same code is left alone (`since` keeps
 *   pointing at the *first* failure, and no KV write happens);
 * - a record whose active lane changed since the failing operation started is
 *   left alone — the switch already re-verified whatever is active now.
 *
 * Never throws: detection must not be able to turn a failed upload into a
 * differently-failed upload.
 */
export async function noteStorageFailure(
  env: Env,
  workspaceName: string,
  ws: WorkspaceRecord,
  err: unknown,
): Promise<void> {
  const code = classifyStorageFailure(err);
  if (!code) return;
  if (!isByoRecord(ws)) return;
  if (ws.storageUnhealthyAt && healthCodeOf(ws.storageUnhealthyCode) === code) return;

  const nowIso = new Date().toISOString();
  const laneId = ws.storageLaneId;
  try {
    await mutateWorkspaceRecord(env, workspaceName, (current) => {
      if (!isByoRecord(current)) return null;
      // The operation failed against the lane that was active when it
      // started; if the workspace has switched since, that lane is no longer
      // the one this flag would describe.
      if ((current.storageLaneId ?? null) !== (laneId ?? null)) return null;
      if (current.storageUnhealthyAt && healthCodeOf(current.storageUnhealthyCode) === code)
        return null;
      return {
        ...current,
        // First failure wins: `since` is "failing since", not "last failed".
        storageUnhealthyAt: current.storageUnhealthyAt ?? nowIso,
        storageUnhealthyCode: code,
      };
    });
  } catch {
    // A losing write race or a workspace deleted mid-request. The next
    // failing operation re-attempts the flag; nothing here is worth failing
    // the caller's request over.
    return;
  }
  console.log(
    JSON.stringify({
      event: "workspace_storage_unhealthy",
      workspace: workspaceName,
      laneId,
      code,
    }),
  );
}

/**
 * Clears the flag after a storage operation succeeds. The self-healing half
 * of {@link noteStorageFailure}: a workspace that rotates its token outside
 * this app (or whose bucket comes back) drops the banner on its next upload
 * without anyone visiting settings.
 *
 * Costs nothing on the overwhelmingly common path — a record with no flag
 * returns before touching KV.
 */
export async function noteStorageSuccess(
  env: Env,
  workspaceName: string,
  ws: WorkspaceRecord,
): Promise<void> {
  if (!ws.storageUnhealthyAt) return;
  const laneId = ws.storageLaneId;
  try {
    await mutateWorkspaceRecord(env, workspaceName, (current) => {
      if (!current.storageUnhealthyAt) return null;
      if ((current.storageLaneId ?? null) !== (laneId ?? null)) return null;
      const next = { ...current };
      clearStorageHealthFields(next);
      return next;
    });
  } catch {
    return;
  }
  console.log(
    JSON.stringify({ event: "workspace_storage_recovered", workspace: workspaceName, laneId }),
  );
}
