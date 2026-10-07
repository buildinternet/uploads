/**
 * The admin operator "Clients" view: which CLI / MCP client, at which
 * version, each credential last used, with an outdated badge against the
 * published CLI (`/cli-version.json`). Rows come from `/admin-ui/clients`
 * (the `client_activity` table, refreshed at most hourly per credential, or
 * immediately when its version changes).
 *
 * Mounted by `pages/admin/clients.astro` with the same manual SSR + hydrate
 * mechanism as AdminWorkspacesTable.
 */
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@uploads/ui/components/ui/badge";
import { Checkbox } from "@uploads/ui/components/ui/checkbox";
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
import { makeAdminApi, type AdminClientActivity } from "../../lib/admin-api";
import {
  clientLabel,
  clientOwnerLabel,
  clientVersionStatus,
  fetchLatestCliVersion,
  summarizeClients,
  surfaceLabel,
} from "../../lib/admin-clients";
import { formatAdminDate } from "../../lib/admin-ui";
import { ClientVersion } from "./ClientVersion";
import { SELECT_SM } from "./field-classes";

export interface AdminClientsTableProps {
  apiOrigin: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; clients: AdminClientActivity[] };

const WINDOWS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 0, label: "All time" },
];

function AdminClientsTableInner({ apiOrigin }: AdminClientsTableProps) {
  const api = useMemo(() => makeAdminApi(apiOrigin), [apiOrigin]);
  const [days, setDays] = useState(30);
  const [outdatedOnly, setOutdatedOnly] = useState(false);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [latest, setLatest] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchLatestCliVersion().then((v) => alive && setLatest(v));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    api
      .listClients({ days })
      .then((clients) => alive && setState({ status: "ok", clients }))
      .catch(() => alive && setState({ status: "error" }));
    return () => {
      alive = false;
    };
  }, [api, days]);

  const clients = state.status === "ok" ? state.clients : [];
  const visible = useMemo(
    () =>
      outdatedOnly
        ? clients.filter((row) => clientVersionStatus(row, latest) === "outdated")
        : clients,
    [clients, outdatedOnly, latest],
  );
  const summary = useMemo(() => summarizeClients(clients, latest), [clients, latest]);

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-(length:--text-micro)">
        <label className="inline-flex items-center gap-2 text-muted-foreground">
          Seen in
          <select
            className={SELECT_SM}
            style={{ width: "auto" }}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {WINDOWS.map((w) => (
              <option key={w.days} value={w.days}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-flex items-center gap-2 text-muted-foreground">
          <Checkbox
            checked={outdatedOnly}
            onCheckedChange={(checked) => setOutdatedOnly(checked === true)}
          />
          Outdated only
        </label>
        <span className="text-muted-foreground" role="status" aria-live="polite">
          {latest ? (
            <>
              Latest CLI <span className="font-mono text-foreground">{latest}</span>
              {state.status === "ok"
                ? ` · ${summary.outdated} of ${summary.tracked} CLI clients outdated`
                : null}
            </>
          ) : (
            "Latest CLI version unavailable"
          )}
        </span>
      </div>

      {state.status === "loading" ? (
        <p className="text-(length:--text-meta) text-muted-foreground">Loading…</p>
      ) : state.status === "error" ? (
        <p className="text-(length:--text-meta) text-destructive">Failed to load clients.</p>
      ) : visible.length === 0 ? (
        <p className="text-(length:--text-meta) text-muted-foreground">
          {outdatedOnly ? "No outdated clients in this window." : "No client activity yet."}
        </p>
      ) : (
        <div className="w-full overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workspace</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Surface</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => (
                <TableRow key={`${row.workspace}|${row.principal}|${row.surface}`}>
                  <TableCell className="font-mono">{row.workspace}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="truncate">{clientOwnerLabel(row)}</span>
                      {row.serviceToken ? <Badge variant="secondary">service</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {surfaceLabel(row.surface)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{clientLabel(row)}</TableCell>
                  <TableCell>
                    <ClientVersion row={row} latest={latest} />
                  </TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    <time dateTime={row.lastSeenAt} title={row.lastSeenAt}>
                      {formatAdminDate(row.lastSeenAt)}
                    </time>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function AdminClientsTable(props: AdminClientsTableProps) {
  return (
    <IslandErrorBoundary>
      <AdminClientsTableInner {...props} />
    </IslandErrorBoundary>
  );
}
