/**
 * API tokens on the workspace — read-only list with ownership (issue #1026).
 * A `workspace`-owned service token gets a "service" badge and names the admin
 * who minted it; a personal token names its minting member. User ids resolve
 * against the org members list the drawer already reads (no per-row auth
 * lookup); an id that is no longer a member shows raw.
 */
import { Badge } from "@uploads/ui/components/ui/badge";
import { formatDate } from "../../lib/subscription-copy";
import type { AdminApi } from "../../lib/admin-api";
import { tokenAttribution } from "../../lib/admin-token-attribution";
import { Muted, SectionHeading } from "./StatusLine";
import { useAdminResource } from "./use-admin-resource";

export function TokensSection({
  api,
  workspace,
  hasOrg,
}: {
  api: AdminApi;
  workspace: string;
  hasOrg: boolean;
}) {
  const { data, error } = useAdminResource(
    () =>
      Promise.all([
        api.getTokens(workspace),
        // Identity lookup is best-effort: a members failure leaves raw ids.
        hasOrg ? api.getMembers(workspace).catch(() => []) : Promise.resolve([]),
      ]).then(([tokens, members]) => ({
        tokens,
        emailByUserId: new Map(members.map((m) => [m.userId, m.email])),
      })),
    [api, workspace, hasOrg],
  );

  if (error) return <Muted>Failed to load tokens.</Muted>;
  if (!data) return <Muted>Loading tokens…</Muted>;

  const { tokens, emailByUserId } = data;
  return (
    <div>
      <SectionHeading>API tokens</SectionHeading>
      {tokens.length === 0 ? (
        <Muted>No tokens.</Muted>
      ) : (
        <ul className="grid list-none gap-1.5 p-0">
          {tokens.map((t) => {
            const attribution = tokenAttribution(t, emailByUserId);
            const state = t.revokedAt
              ? "revoked"
              : t.expiresAt && Date.parse(t.expiresAt) <= Date.now()
                ? "expired"
                : null;
            return (
              <li
                key={`${t.source}-${t.hashPrefix}`}
                className={
                  "grid gap-0.5 text-(length:--text-micro) text-body" + (state ? " opacity-60" : "")
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{t.label ?? "(no label)"}</span>
                    {t.owner === "workspace" ? <Badge variant="secondary">service</Badge> : null}
                    {t.source === "legacy" ? <Badge variant="outline">legacy</Badge> : null}
                  </span>
                  <span className="shrink-0 font-mono text-muted-foreground">{t.hashPrefix}</span>
                </div>
                <div className="text-muted-foreground">
                  {[
                    t.scopes.join(", "),
                    attribution,
                    `created ${formatDate(t.createdAt) ?? t.createdAt}`,
                    state,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
