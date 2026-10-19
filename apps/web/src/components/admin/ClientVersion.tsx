import { Badge } from "@uploads/ui/components/ui/badge";
import type { AdminClientActivity } from "../../lib/admin-api";
import { clientOwnerLabel, clientVersionStatus } from "../../lib/admin-clients";

/**
 * Version text plus an outdated badge when it trails the published CLI.
 * Hosted-MCP rows carry the MCP host's own version (Claude Code, Codex, …),
 * not ours, so it is muted and says so on hover.
 */
export function ClientVersion({
  row,
  latest,
}: {
  row: AdminClientActivity;
  latest: string | null;
}) {
  const status = clientVersionStatus(row, latest);
  if (row.surface === "mcp-remote") {
    return (
      <span
        className="font-mono text-muted-foreground"
        title={`${row.clientName ?? "MCP host"} version, not an uploads version`}
      >
        {row.clientVersion ?? "—"}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono">{row.clientVersion ?? "< 0.57.0"}</span>
      {status === "outdated" ? (
        <Badge variant="destructive" title={latest ? `Latest is ${latest}` : undefined}>
          outdated
        </Badge>
      ) : null}
    </span>
  );
}

/** Who owns the credential, with a badge for workspace service tokens. */
export function ClientOwner({ row }: { row: AdminClientActivity }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{clientOwnerLabel(row)}</span>
      {row.serviceToken ? <Badge variant="secondary">service</Badge> : null}
    </span>
  );
}
