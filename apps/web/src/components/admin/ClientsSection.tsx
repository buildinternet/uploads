/**
 * CLI / MCP clients on the workspace — which client and version each
 * credential last used (all time), with an outdated badge against the
 * published CLI. Read-only; the cross-workspace view is /admin/clients.
 */
import type { AdminApi } from "../../lib/admin-api";
import { clientLabel, fetchLatestCliVersion, surfaceLabel } from "../../lib/admin-clients";
import { formatDate } from "../../lib/subscription-copy";
import { ClientOwner, ClientVersion } from "./ClientVersion";
import { Muted, SectionHeading } from "./StatusLine";
import { useAdminResource } from "./use-admin-resource";

export function ClientsSection({ api, workspace }: { api: AdminApi; workspace: string }) {
  const { data, error } = useAdminResource(
    () =>
      Promise.all([api.listClients({ workspace, days: 0 }), fetchLatestCliVersion()]).then(
        ([clients, latest]) => ({ clients, latest }),
      ),
    [api, workspace],
  );

  if (error) return <Muted>Failed to load clients.</Muted>;
  if (!data) return <Muted>Loading clients…</Muted>;

  const { clients, latest } = data;
  return (
    <div>
      <SectionHeading>Clients</SectionHeading>
      {clients.length === 0 ? (
        <Muted>No CLI or MCP activity recorded.</Muted>
      ) : (
        <ul className="grid list-none gap-1.5 p-0">
          {clients.map((row) => (
            <li
              key={`${row.principal}|${row.surface}`}
              className="grid gap-0.5 text-(length:--text-micro) text-body"
            >
              <div className="flex items-center justify-between gap-2">
                <ClientOwner row={row} />
                <ClientVersion row={row} latest={latest} />
              </div>
              <div className="text-muted-foreground">
                {[
                  surfaceLabel(row.surface),
                  clientLabel(row),
                  `last seen ${formatDate(row.lastSeenAt) ?? row.lastSeenAt}`,
                ].join(" · ")}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
