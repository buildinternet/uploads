/**
 * Per-workspace stale-while-revalidate snapshot for the account shell.
 *
 * `localStorage`, not `sessionStorage` (which `workspaces-nav.ts` uses for the
 * membership list): a snapshot exists to make a *returning* tab paint known
 * values instead of placeholders, and a session-scoped store makes every new
 * tab a first visit.
 *
 * UX affordance only. Membership is enforced server-side on every request, so
 * a stale — or hand-edited — entry can never widen access. The TTL bounds how
 * wrong a painted value may be; the schema version invalidates every entry at
 * once when the shape changes, so there is no migration path to maintain.
 *
 * The storage-agnostic `*From`/`*To`/`*In` core is what the tests drive: the
 * suite runs in a node environment with no `localStorage` at all.
 */
import type { MyWorkspace, WorkspaceUsage } from "./api-client";
import type { UsageSnapshot } from "./workspace-ui";

/** Bump to invalidate every stored snapshot without writing a migration. */
export const WORKSPACE_SNAPSHOT_VERSION = 1;

/** How stale a painted value may be before we prefer a placeholder. */
export const WORKSPACE_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

const KEY_PREFIX = "uploads:ws:";

/**
 * The slice of `Storage` this module needs. Declaring it explicitly keeps the
 * core testable from node, where `Storage` does not exist.
 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export interface WorkspaceSnapshot {
  slug: string;
  role: string;
  hasPublicUrl: boolean;
  publicBaseUrl?: string;
  plan?: string;
  usage?: UsageSnapshot;
}

interface StoredSnapshot {
  v: number;
  at: number;
  data: WorkspaceSnapshot;
}

/**
 * Storage key for a workspace.
 *
 * Keep in sync with any consumer that cannot import this module — inline boot
 * scripts in layouts can only hardcode the string. `workspace-cache.test.ts`
 * pins the format so a rename can't drift past review unnoticed.
 */
export function workspaceSnapshotKey(workspace: string): string {
  return `${KEY_PREFIX}${workspace}`;
}

export function readSnapshotFrom(
  store: KeyValueStore,
  workspace: string,
  now: number = Date.now(),
): WorkspaceSnapshot | null {
  const key = workspaceSnapshotKey(workspace);
  let raw: string | null = null;
  try {
    raw = store.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: StoredSnapshot | null = null;
  try {
    parsed = JSON.parse(raw) as StoredSnapshot;
  } catch {
    parsed = null;
  }

  const usable =
    parsed?.v === WORKSPACE_SNAPSHOT_VERSION &&
    typeof parsed.at === "number" &&
    !!parsed.data &&
    now - parsed.at <= WORKSPACE_SNAPSHOT_TTL_MS;

  if (!usable || !parsed) {
    // Drop anything we refused to use so a stale or malformed entry doesn't
    // sit there being re-parsed on every navigation.
    try {
      store.removeItem(key);
    } catch {
      // ignore
    }
    return null;
  }
  return parsed.data;
}

export function writeSnapshotTo(
  store: KeyValueStore,
  workspace: string,
  snapshot: WorkspaceSnapshot,
  now: number = Date.now(),
): void {
  const payload: StoredSnapshot = { v: WORKSPACE_SNAPSHOT_VERSION, at: now, data: snapshot };
  try {
    store.setItem(workspaceSnapshotKey(workspace), JSON.stringify(payload));
  } catch {
    // Private mode / quota — the shell still renders, just without a warm paint.
  }
}

export function clearSnapshotsIn(store: KeyValueStore): void {
  const doomed: string[] = [];
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith(KEY_PREFIX)) doomed.push(key);
    }
    // Collect first, then delete: removing during iteration reindexes the store.
    for (const key of doomed) store.removeItem(key);
  } catch {
    // ignore
  }
}

/** `localStorage` when it exists and is reachable, else null (node, private mode). */
function browserStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readWorkspaceSnapshot(
  workspace: string,
  now: number = Date.now(),
): WorkspaceSnapshot | null {
  const store = browserStore();
  return store ? readSnapshotFrom(store, workspace, now) : null;
}

export function writeWorkspaceSnapshot(
  workspace: string,
  snapshot: WorkspaceSnapshot,
  now: number = Date.now(),
): void {
  const store = browserStore();
  if (store) writeSnapshotTo(store, workspace, snapshot, now);
}

export function clearWorkspaceSnapshots(): void {
  const store = browserStore();
  if (store) clearSnapshotsIn(store);
}

/** Project a successful `/summary` response onto the cached shape. */
export function toWorkspaceSnapshot(
  workspace: MyWorkspace,
  usage: WorkspaceUsage | null,
): WorkspaceSnapshot {
  return {
    slug: workspace.organization.slug,
    role: workspace.role,
    hasPublicUrl: workspace.hasPublicUrl,
    publicBaseUrl: workspace.publicBaseUrl,
    plan: workspace.plan,
    usage: usage
      ? {
          bytes: usage.bytes,
          objects: usage.objects,
          uploadsInPeriod: usage.uploadsInPeriod,
          maxStorageBytes: usage.maxStorageBytes,
          maxUploadsPerPeriod: usage.maxUploadsPerPeriod,
        }
      : undefined,
  };
}
