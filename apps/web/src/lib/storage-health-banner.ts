/**
 * Signed-in banner for a broken BYO bucket (issue #826).
 *
 * An admin shouldn't have to open the storage settings tab to find out that
 * uploads are failing, so every workspace tab checks the active lane's health
 * once per page load and paints a dismissable notice pointing at the fix.
 *
 * Only admins ever see it: `GET /v1/workspaces/:name/storage` is admin/owner
 * only, and a non-admin's 403 lands in the same silent no-op as any other
 * unavailable result. Nothing is ever painted from a failed or unparseable
 * response — `getWorkspaceStorageStatus` already fails healthy.
 */
import { getWorkspaceStorageStatus } from "./api-client";
import { onSession } from "./account-shell";

/** sessionStorage prefix for per-failure dismissals. */
const DISMISS_KEY_PREFIX = "uploads:storageHealthDismissed:";

/**
 * Dismissal is scoped to the workspace *and* the failure it was dismissed
 * for: a lane that recovers and breaks again gets a fresh `since`, and so a
 * fresh banner. sessionStorage (not localStorage) because "I've seen it, stop
 * following me around this session" is the actual ask — a still-broken bucket
 * is worth re-raising next time they sign in.
 */
function dismissKey(workspace: string, since: string | undefined): string {
  return `${DISMISS_KEY_PREFIX}${workspace}:${since ?? "unknown"}`;
}

function isDismissed(workspace: string, since: string | undefined): boolean {
  try {
    return sessionStorage.getItem(dismissKey(workspace, since)) === "1";
  } catch {
    return false;
  }
}

function markDismissed(workspace: string, since: string | undefined): void {
  try {
    sessionStorage.setItem(dismissKey(workspace, since), "1");
  } catch {
    // Private mode / quota — the banner just reappears on the next tab.
  }
}

export function storageSettingsPath(workspace: string): string {
  return `/account/workspaces/${encodeURIComponent(workspace)}/settings/storage`;
}

export interface InitStorageHealthBannerOptions {
  /** Query root for `[data-storage-health-banner]`. Defaults to `document`. */
  root?: Document | Element;
  /** Current path, for the "already on the fix page" check. Defaults to `location.pathname`. */
  pathname?: string;
}

/**
 * Mounts the banner for one workspace-tab page load. Safe to call on every
 * tab: it no-ops when the banner element is absent, when the caller is not an
 * admin, when storage is healthy, when the notice was already dismissed for
 * this failure, and when the user is already on the storage settings page
 * (where the lane card says the same thing in more detail — a banner above it
 * would be pure repetition).
 */
export function initStorageHealthBanner(
  apiOrigin: string,
  workspace: string,
  opts: InitStorageHealthBannerOptions = {},
): void {
  const root = opts.root ?? document;
  const banner = root.querySelector<HTMLElement>("[data-storage-health-banner]");
  if (!banner || !workspace) return;
  const settingsPath = storageSettingsPath(workspace);
  const pathname = opts.pathname ?? location.pathname;
  if (pathname === settingsPath) return;

  onSession(() => {
    void getWorkspaceStorageStatus(apiOrigin, workspace).then((result) => {
      if (result.kind !== "ok") return;
      const { health } = result.status;
      if (health.ok || !health.message) return;
      if (isDismissed(workspace, health.since)) return;

      const messageEl = banner.querySelector<HTMLElement>("[data-storage-health-message]");
      const linkEl = banner.querySelector<HTMLAnchorElement>("[data-storage-health-link]");
      const dismissEl = banner.querySelector<HTMLButtonElement>("[data-storage-health-dismiss]");
      // Server-authored sentence, set as text — never as markup.
      if (messageEl) {
        messageEl.textContent = `${health.message}. New uploads to this workspace are failing.`;
      }
      if (linkEl) linkEl.href = settingsPath;
      dismissEl?.addEventListener("click", () => {
        banner.hidden = true;
        markDismissed(workspace, health.since);
      });
      banner.hidden = false;
    });
  });
}
