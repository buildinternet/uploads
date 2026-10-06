/**
 * Column sorting for the admin Workspaces table (`AdminWorkspacesTable`).
 * Pure so it is testable without rendering the island.
 */
import type { AdminWorkspaceSummary } from "./admin-api";

export type SortKey = "workspace" | "created" | "plan" | "storage" | "members" | "pending";
export type SortDir = "asc" | "desc";

/** First click on a column: names read A→Z, everything else biggest/newest first. */
export const DEFAULT_SORT_DIR: Record<SortKey, SortDir> = {
  workspace: "asc",
  created: "desc",
  plan: "desc",
  storage: "desc",
  members: "desc",
  pending: "desc",
};

const PLAN_RANK: Record<string, number> = { free: 0, pro: 1 };

/**
 * Sortable value per column. A missing creation date sorts as oldest so
 * undated legacy workspaces sink below everything dated when newest-first.
 */
function sortValue(ws: AdminWorkspaceSummary, key: SortKey): string | number {
  switch (key) {
    case "workspace":
      return ws.workspace;
    case "created":
      return ws.createdAt ? Date.parse(ws.createdAt) || 0 : 0;
    case "plan":
      return PLAN_RANK[ws.plan] ?? 2;
    case "storage":
      return ws.byob ? 1 : 0;
    case "members":
      return ws.memberCount;
    case "pending":
      return ws.pendingInviteCount;
  }
}

export function sortWorkspaces(
  rows: readonly AdminWorkspaceSummary[],
  key: SortKey,
  dir: SortDir,
): AdminWorkspaceSummary[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    const primary =
      typeof av === "string" && typeof bv === "string"
        ? av.localeCompare(bv)
        : Number(av) - Number(bv);
    // Ties fall back to name A→Z regardless of direction so the order is stable.
    return primary !== 0 ? primary * sign : a.workspace.localeCompare(b.workspace);
  });
}
