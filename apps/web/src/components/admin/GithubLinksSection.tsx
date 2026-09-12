/**
 * GitHub repos claimed by the workspace — read-only list, the React port of
 * the imperative `renderGithubLinks`. Renders nothing when there are no links
 * (same as before), so the section collapses out of the drawer.
 */
import { useEffect, useState } from "react";
import type { AdminApi, AdminGithubLink } from "../../lib/admin-api";
import { Muted, SectionHeading } from "./StatusLine";

export function GithubLinksSection({ api, workspace }: { api: AdminApi; workspace: string }) {
  const [links, setLinks] = useState<AdminGithubLink[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .getGithubLinks(workspace)
      .then((l) => alive && setLinks(l))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [api, workspace]);

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
