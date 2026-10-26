/**
 * Signed-in banner for a broken BYO bucket (issue #826).
 *
 * An admin shouldn't have to open the Storage tab to find out that
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
import { workspaceStorageBucketHref, workspaceStoragePath } from "./workspace-browse-url";

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

/**
 * Where the banner's action link points. On the Storage tab the bucket card
 * is on the same page, so a bare `#bucket` fragment scrolls to it without a
 * navigation; on every other tab it is the full Storage URL with `#bucket`.
 */
export function storageBannerLinkHref(workspace: string, pathname: string): string {
  return pathname === workspaceStoragePath(workspace)
    ? "#bucket"
    : workspaceStorageBucketHref(workspace);
}

export interface InitStorageHealthBannerOptions {
  /** Query root for `[data-storage-health-banner]`. Defaults to `document`. */
  root?: Document | Element;
  /** Current path, to keep the link on-page when already on Storage. Defaults to `location.pathname`. */
  pathname?: string;
}

/**
 * Mounts the banner for one workspace-tab page load. Safe to call on every
 * tab: it no-ops when the banner element is absent, when the caller is not an
 * admin, when storage is healthy, when the notice was already dismissed for
 * this failure. On the Storage tab the banner stays visible, because the
 * bucket section sits below the full bucket browser; its link jumps to
 * `#bucket` on the same page instead of navigating away.
 */
export function initStorageHealthBanner(
  apiOrigin: string,
  workspace: string,
  opts: InitStorageHealthBannerOptions = {},
): void {
  const root = opts.root ?? document;
  const banner = root.querySelector<HTMLElement>("[data-storage-health-banner]");
  if (!banner || !workspace) return;
  const pathname = opts.pathname ?? location.pathname;

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
      if (linkEl) linkEl.href = storageBannerLinkHref(workspace, pathname);
      dismissEl?.addEventListener("click", () => {
        banner.hidden = true;
        markDismissed(workspace, health.since);
      });
      banner.hidden = false;
    });
  });
}
