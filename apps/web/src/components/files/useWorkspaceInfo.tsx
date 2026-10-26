/**
 * Workspace-level facts (hasPublicUrl) behind session resolution, shared by
 * every Files view. Moved from ScreenshotsByPath's info effect: an SSR-seeded
 * "ready" value is kept on hydrate, and a retry goes back through loading.
 */
import { useEffect, useState } from "react";
import { onSession } from "../../lib/account-shell";
import { resolveWorkspaceInfo, type WorkspaceInfoStatus } from "../../lib/workspace-file-row";
import { loadWorkspaces } from "../../lib/workspaces-nav";

export type WorkspaceInfoState = WorkspaceInfoStatus | { status: "loading" };

export function useWorkspaceInfo(
  apiOrigin: string,
  workspace: string,
  initialInfo?: WorkspaceInfoStatus,
): { info: WorkspaceInfoState; retry: () => void } {
  const [info, setInfo] = useState<WorkspaceInfoState>(() => initialInfo ?? { status: "loading" });
  const [nonce, setNonce] = useState(0);
  // Workspace-level facts (hasPublicUrl), gated behind session resolution —
  // same pattern as WorkspaceFileTable.
  useEffect(() => {
    let cancelled = false;
    // Don't flash the full-page skeleton over SSR-seeded info on hydrate.
    // Retry (nonce) still goes through loading because prev is not ready.
    setInfo((prev) => (prev.status === "ready" ? prev : { status: "loading" }));
    onSession(() => {
      void loadWorkspaces(apiOrigin).then((result) => {
        if (cancelled) return;
        setInfo(resolveWorkspaceInfo(result, workspace));
      });
    });
    return () => {
      cancelled = true;
    };
  }, [apiOrigin, workspace, nonce]);
  return { info, retry: () => setNonce((n) => n + 1) };
}

/** The two non-ready, non-loading states, rendered the same way on every view. */
export function InfoBlocked({
  info,
  retry,
}: {
  info: { status: "unavailable" } | { status: "no-access" };
  retry: () => void;
}) {
  if (info.status === "unavailable") {
    return (
      <div className="wft-status-block">
        <p className="wft-error" role="alert">
          Workspaces are temporarily unavailable. Check the local stack or try again.
        </p>
        <button type="button" className="text-btn" onClick={retry}>
          Try again
        </button>
      </div>
    );
  }
  return (
    <p className="wft-error" role="alert">
      You don’t have access to this workspace.
    </p>
  );
}
