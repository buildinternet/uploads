/**
 * One `/me/workspaces/:name/summary` request per workspace per page load.
 *
 * Before this existed, a workspace tab issued three overlapping requests for
 * the same authorization fact: the page fetched the whole membership list to
 * run a `.find()` over it, the rail fetched this workspace's summary, and the
 * sidebar fetched the list again for the switcher. The page's list fetch was
 * pure duplication — the summary endpoint answers "am I a member of this
 * workspace" in one round trip — and the rail's copy of it can be shared.
 *
 * Callers that arrive while a request is still in flight join it. Once it
 * settles the entry is dropped, so a later navigation revalidates rather than
 * serving a stale promise for the life of the tab.
 *
 * A successful response also refreshes the workspace snapshot, which is what
 * makes the *next* visit paint without waiting on the network at all.
 */
import { getWorkspaceSummary, type WorkspaceSummaryResult } from "./api-client";
import { toWorkspaceSnapshot, writeWorkspaceSnapshot } from "./workspace-cache";

export type SummaryFetcher = (
  apiOrigin: string,
  workspace: string,
) => Promise<WorkspaceSummaryResult>;

const inFlight = new Map<string, Promise<WorkspaceSummaryResult>>();

export function loadWorkspaceSummary(
  apiOrigin: string,
  workspace: string,
  fetcher: SummaryFetcher = getWorkspaceSummary,
): Promise<WorkspaceSummaryResult> {
  const existing = inFlight.get(workspace);
  if (existing) return existing;

  const request = fetcher(apiOrigin, workspace)
    .then((result) => {
      if (result.kind === "success") {
        writeWorkspaceSnapshot(workspace, toWorkspaceSnapshot(result.workspace, result.usage));
      }
      return result;
    })
    .finally(() => {
      inFlight.delete(workspace);
    });

  inFlight.set(workspace, request);
  return request;
}

/** Drop memoized requests. Tests use this; production never needs it. */
export function resetInFlightSummaries(): void {
  inFlight.clear();
}
