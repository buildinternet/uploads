/**
 * The admin operator "Workspaces" view: a shadcn `Table` of every registered
 * workspace with at-a-glance Plan and BYOB columns (previously only visible by
 * expanding a row), and a right-hand `Sheet` drawer for the full per-workspace
 * detail (people, plan, limits, storage, GitHub links). Replaces the imperative
 * innerHTML table the page shipped with.
 *
 * The single island mounted by `pages/admin/index.astro` (manual SSR +
 * hydrateRoot, no `client:*` — same mechanism as WorkspaceFileTable). It
 * composes `IslandErrorBoundary` itself so mounting it directly reconciles
 * against the SSR'd tree without an extra wrapper. Data is fetched on mount
 * against `/admin-ui/*`, which independently enforces admin access — the
 * client-side gate in AdminLayout is a UX affordance only.
 */
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@uploads/ui/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@uploads/ui/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@uploads/ui/components/ui/table";
import "@uploads/ui/styles.css";
import { IslandErrorBoundary } from "../IslandErrorBoundary";
import { makeAdminApi, type AdminWorkspaceSummary } from "../../lib/admin-api";
import { WorkspaceDetail } from "./WorkspaceDetail";

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; workspaces: AdminWorkspaceSummary[] };

export interface AdminWorkspacesTableProps {
  apiOrigin: string;
}

function AdminWorkspacesTableInner({ apiOrigin }: AdminWorkspacesTableProps) {
  const api = useMemo(() => makeAdminApi(apiOrigin), [apiOrigin]);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selected, setSelected] = useState<AdminWorkspaceSummary | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listWorkspaces()
      .then((workspaces) => alive && setState({ status: "ok", workspaces }))
      .catch(() => alive && setState({ status: "error" }));
    return () => {
      alive = false;
    };
  }, [api]);

  if (state.status === "loading") {
    return <p className="text-(length:--text-meta) text-muted-foreground">Loading…</p>;
  }
  if (state.status === "error") {
    return <p className="text-(length:--text-meta) text-destructive">Failed to load workspaces.</p>;
  }
  if (state.workspaces.length === 0) {
    return <p className="text-(length:--text-meta) text-muted-foreground">No workspaces yet.</p>;
  }

  return (
    <>
      <div className="w-full overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workspace</TableHead>
              <TableHead>Organization</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Storage</TableHead>
              <TableHead className="text-right">Members</TableHead>
              <TableHead className="text-right">Pending</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.workspaces.map((ws) => (
              <TableRow
                key={ws.workspace}
                tabIndex={0}
                role="button"
                aria-label={`Open ${ws.workspace} details`}
                className="cursor-pointer"
                onClick={() => setSelected(ws)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(ws);
                  }
                }}
              >
                <TableCell className="font-mono font-medium text-foreground">
                  {ws.workspace}
                </TableCell>
                <TableCell className={ws.organization ? "" : "text-muted-foreground"}>
                  {ws.organization ? ws.organization.name : "no organization yet"}
                </TableCell>
                <TableCell>
                  {ws.plan === "free" ? (
                    <span className="text-muted-foreground">Free</span>
                  ) : (
                    <Badge variant="default">{ws.plan === "pro" ? "Pro" : ws.plan}</Badge>
                  )}
                </TableCell>
                <TableCell>
                  {ws.byob ? (
                    <Badge variant="secondary">BYO</Badge>
                  ) : (
                    <span className="text-muted-foreground">Shared</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">{ws.memberCount}</TableCell>
                <TableCell className="text-right tabular-nums">{ws.pendingInviteCount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="font-mono">{selected.workspace}</SheetTitle>
                <SheetDescription>
                  {selected.organization
                    ? selected.organization.name
                    : "No organization provisioned yet"}
                </SheetDescription>
              </SheetHeader>
              <div className="px-4 pb-6">
                <WorkspaceDetail
                  key={selected.workspace}
                  api={api}
                  workspace={selected.workspace}
                  hasOrg={selected.organization !== null}
                />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

export function AdminWorkspacesTable(props: AdminWorkspacesTableProps) {
  return (
    <IslandErrorBoundary>
      <AdminWorkspacesTableInner {...props} />
    </IslandErrorBoundary>
  );
}
