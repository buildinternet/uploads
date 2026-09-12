/**
 * Body of the workspace side drawer: the same detail the imperative page put
 * behind a row-expand (people, plan, limits, storage, GitHub links), now
 * composed as React sections inside the shadcn `Sheet`. Each section owns its
 * own fetch and error state, so they fill in independently as their requests
 * land — matching the per-section lazy loads the expand-row used.
 */
import type { AdminApi } from "../../lib/admin-api";
import { GithubLinksSection } from "./GithubLinksSection";
import { LimitsEditor } from "./LimitsEditor";
import { PeopleSection } from "./PeopleSection";
import { PlanEditor } from "./PlanEditor";
import { StorageEditor } from "./StorageEditor";

export function WorkspaceDetail({
  api,
  workspace,
  hasOrg,
}: {
  api: AdminApi;
  workspace: string;
  hasOrg: boolean;
}) {
  // `key={workspace}` on each section is set by the parent remounting the whole
  // WorkspaceDetail per selection, so nothing here needs to reset on change.
  return (
    <div className="grid gap-4">
      <PeopleSection api={api} workspace={workspace} hasOrg={hasOrg} />
      <div className="border-t border-border pt-4">
        <PlanEditor api={api} workspace={workspace} />
      </div>
      <div className="border-t border-border pt-4">
        <LimitsEditor api={api} workspace={workspace} />
      </div>
      <div className="border-t border-border pt-4">
        <StorageEditor api={api} workspace={workspace} />
      </div>
      <GithubLinksSection api={api} workspace={workspace} />
    </div>
  );
}
