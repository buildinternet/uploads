/**
 * The admin operator "Workspaces" view: a shadcn `Table` of every registered
 * workspace with at-a-glance Plan, BYOB, and creation-date columns, sortable by
 * any column header, and a right-hand `Sheet` drawer for the full
 * per-workspace detail (people, plan, limits, storage, GitHub links). The
 * backing organization's name rides under the workspace slug as a byline
 * rather than a column of its own — it only differs from the slug once a
 * workspace has been renamed.
 *
 * The single island mounted by `pages/admin/index.astro` (manual SSR +
 * hydrateRoot, no `client:*` — same mechanism as WorkspaceFileTable). It
 * composes `IslandErrorBoundary` itself so mounting it directly reconciles
 * against the SSR'd tree without an extra wrapper. Data is fetched on mount
 * against `/admin-ui/*`, which independently enforces admin access — the
 * client-side gate in AdminLayout is a UX affordance only.
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
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
import { formatAdminDate } from "../../lib/admin-ui";
import {
  DEFAULT_SORT_DIR,
  sortWorkspaces,
  type SortDir,
  type SortKey,
} from "../../lib/admin-workspace-sort";
import { WorkspaceDetail } from "./WorkspaceDetail";

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; workspaces: AdminWorkspaceSummary[] };

export interface AdminWorkspacesTableProps {
  apiOrigin: string;
}

const COLUMNS: [SortKey, string, ("left" | "right")?][] = [
  ["workspace", "Workspace"],
  ["created", "Created"],
  ["plan", "Plan"],
  ["storage", "Storage"],
  ["members", "Members", "right"],
  ["pending", "Pending", "right"],
];

/** The org name under the slug, only when it adds information (most orgs share the slug). */
function orgByline(ws: AdminWorkspaceSummary): string | null {
  if (!ws.organization) return "no organization yet";
  return ws.organization.name !== ws.workspace ? ws.organization.name : null;
}

function SortableHead({
  label,
  column,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  column: SortKey;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === column;
  const Icon = sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={align === "right" ? "text-right" : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring ${
          align === "right" ? "flex-row-reverse" : ""
        } ${active ? "text-foreground" : ""}`}
      >
        {label}
        <Icon aria-hidden="true" className={`size-3 ${active ? "opacity-100" : "opacity-0"}`} />
      </button>
    </TableHead>
  );
}

function AdminWorkspacesTableInner({ apiOrigin }: AdminWorkspacesTableProps) {
  const api = useMemo(() => makeAdminApi(apiOrigin), [apiOrigin]);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [selected, setSelected] = useState<AdminWorkspaceSummary | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "created",
    dir: DEFAULT_SORT_DIR.created,
  });
  const sorted = useMemo(
    () => (state.status === "ok" ? sortWorkspaces(state.workspaces, sort.key, sort.dir) : []),
    [state, sort],
  );
  const onSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: DEFAULT_SORT_DIR[key] },
    );

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
              {COLUMNS.map(([column, label, align]) => (
                <SortableHead
                  key={column}
                  label={label}
                  column={column}
                  sort={sort}
                  onSort={onSort}
                  align={align}
                />
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((ws) => (
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
                <TableCell>
                  <div className="font-mono font-medium text-foreground">{ws.workspace}</div>
                  {orgByline(ws) && (
                    <div className="text-(length:--text-micro) text-muted-foreground">
                      {orgByline(ws)}
                    </div>
                  )}
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {ws.createdAt ? (
                    <time dateTime={ws.createdAt} title={ws.createdAt}>
                      {formatAdminDate(ws.createdAt)}
                    </time>
                  ) : (
                    "-"
                  )}
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
