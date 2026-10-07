import { Badge } from "@uploads/ui/components/ui/badge";
import type { AdminClientActivity } from "../../lib/admin-api";
import { clientVersionStatus } from "../../lib/admin-clients";

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
