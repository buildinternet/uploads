/**
 * GitHub repos claimed by the workspace — read-only list, the React port of
 * the imperative `renderGithubLinks`. Renders nothing when there are no links
 * (same as before), so the section collapses out of the drawer.
 */
import type { AdminApi } from "../../lib/admin-api";
import { Muted, SectionHeading } from "./StatusLine";
import { useAdminResource } from "./use-admin-resource";

export function GithubLinksSection({ api, workspace }: { api: AdminApi; workspace: string }) {
  const { data: links, error } = useAdminResource(
    () => api.getGithubLinks(workspace),
    [api, workspace],
  );

  if (error) return <Muted>Failed to load GitHub links.</Muted>;
  if (!links || links.length === 0) return null;

  return (
    <div>
      <SectionHeading>GitHub repos claimed</SectionHeading>
      <ul className="grid list-none gap-1 p-0">
        {links.map((l) => (
          <li
            key={`${l.repo}-${l.source}`}
            className="flex justify-between gap-2 text-(length:--text-meta)"
          >
            <span className="font-mono text-(length:--text-micro) text-foreground">{l.repo}</span>
            <span className="text-muted-foreground">{l.source}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
