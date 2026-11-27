/**
 * Shell banner for a workspace whose storage cap is full.
 *
 * Uploads are refused at the cap, but until now the only sign in the app was
 * the sidebar meter turning red. Every workspace tab reads the shared summary
 * (deduped with the sidebar's own read) and reveals a one-line notice.
 * Admins and owners also get the fixes they can make: connect their own
 * bucket, and upgrade unless they are already on the top plan.
 */
import type { WorkspaceSummaryResult } from "./api-client";
import { onSession } from "./account-shell";
import { loadWorkspaceSummary } from "./workspace-summary-source";
import { storageBannerLinkHref } from "./storage-health-banner";

export interface StorageFullBannerState {
  /** Show the "Upgrade" link (admin or owner, and not on Pro). */
  upgrade: boolean;
  /** Show the "Use your own bucket" link (admin or owner). */
  bucket: boolean;
}

/**
 * Whether the summary describes a full storage cap, and which fixes this
 * viewer can make. Compares raw bytes: the meter's rounded percent reads
 * 100 a little before the cap is really reached.
 */
export function storageFullBannerState(
  result: WorkspaceSummaryResult,
): StorageFullBannerState | null {
  if (result.kind !== "success" || !result.usage) return null;
  const { usage, workspace } = result;
  const max = usage.maxStorageBytes;
  if (typeof max !== "number" || !(max > 0)) return null;
  // With a bucket connected the cap only meters what is left on hosted storage.
  const metered = usage.storageBudgetBasis === "shared" ? (usage.sharedBytes ?? 0) : usage.bytes;
  if (!(metered >= max)) return null;
  const admin = workspace.role === "owner" || workspace.role === "admin";
  return { upgrade: admin && workspace.plan !== "pro", bucket: admin };
}

/** Mounts the banner for one workspace-tab page load. No-op without the element. */
export function initStorageFullBanner(apiOrigin: string, workspace: string): void {
  const banner = document.querySelector<HTMLElement>("[data-storage-full-banner]");
  if (!banner || !workspace) return;
  onSession(() => {
    void loadWorkspaceSummary(apiOrigin, workspace).then((result) => {
      const state = storageFullBannerState(result);
      if (!state) return;
      const upgrade = banner.querySelector<HTMLElement>("[data-storage-full-upgrade]");
      const bucket = banner.querySelector<HTMLAnchorElement>("[data-storage-full-bucket]");
      if (upgrade) upgrade.hidden = !state.upgrade;
      if (bucket) {
        bucket.hidden = !state.bucket;
        bucket.href = storageBannerLinkHref(workspace, location.pathname);
      }
      banner.hidden = false;
    });
  });
}
