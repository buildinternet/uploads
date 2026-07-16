/**
 * Nested workspaces list in the account sidebar.
 * Fills `#workspaces-nav-list` after session + GET /me/workspaces.
 */
import { getMyWorkspaces } from "./api-client";
import { onSession } from "./account-shell";
import { escapeHtml } from "./workspace-ui";

export function initWorkspacesNav(apiOrigin: string, listEl: HTMLElement, active = ""): void {
  onSession(() => {
    void getMyWorkspaces(apiOrigin).then((result) => {
      if (result.kind !== "success") return;
      listEl.innerHTML = result.workspaces
        .map((ws) => {
          const label = ws.organization.name || ws.workspace;
          const href = `/account/workspaces/${encodeURIComponent(ws.workspace)}`;
          const current = active === ws.workspace ? ' aria-current="page"' : "";
          return `<a href="${escapeHtml(href)}" class="side-nested-item"${current}>${escapeHtml(label)}</a>`;
        })
        .join("");
    });
  });
}
