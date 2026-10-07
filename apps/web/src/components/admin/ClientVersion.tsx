import { Badge } from "@uploads/ui/components/ui/badge";
import type { AdminClientActivity } from "../../lib/admin-api";
import { clientOwnerLabel, clientVersionStatus } from "../../lib/admin-clients";

/** Version text plus an outdated badge when it trails the published CLI. */
export function ClientVersion({
  row,
  latest,
}: {
  row: AdminClientActivity;
  latest: string | null;
}) {
  const status = clientVersionStatus(row, latest);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-mono">{row.clientVersion ?? "-"}</span>
      {status === "outdated" ? (
        <Badge variant="destructive" title={`Latest is ${latest}`}>
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
