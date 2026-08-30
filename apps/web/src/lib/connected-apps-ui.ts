/**
 * Shared data loader + markup for /account/connected-apps (issue #890) so
 * SSR and the client paint the same grant list. Mirrors
 * account-profile-ui.ts's shape: a pure loader returning `T | null` (null =
 * no cookie / fetch failed) plus a pure, server-safe HTML renderer the
 * client re-invokes to reconcile after its own fetch.
 */
import { listConnectedApps, type ConnectedAppGrant } from "./auth-client";
import { formatSessionTime } from "./session-device";
import { escapeHtml } from "./workspace-ui";

export interface ConnectedAppsPageData {
  grants: ConnectedAppGrant[] | null;
}

/**
 * Server-side data for /account/connected-apps. An empty/missing cookie
 * short-circuits to `null` — first paint falls back to the placeholder and
 * the client fetch fills in, same contract as `loadProfilePageData`.
 */
export async function loadConnectedAppsPageData(
  authOrigin: string,
  cookie: string,
  fetchImpl?: typeof fetch,
): Promise<ConnectedAppsPageData> {
  if (!cookie.trim()) return { grants: null };
  return { grants: await listConnectedApps(authOrigin, { cookie, fetchImpl }) };
}

/** `ws:<slug>` → the plain slug; anything else (incl. null) → account-level wording. */
export function connectedAppWorkspaceLabel(referenceId: string | null): string {
  const prefix = "ws:";
  if (referenceId && referenceId.startsWith(prefix)) {
    return referenceId.slice(prefix.length);
  }
  return "All workspaces";
}

function scopeChipsHtml(scopes: string[]): string {
  if (!scopes.length) return "";
  return `<div class="connected-app-scopes">${scopes
    .map((s) => `<span class="ul-badge">${escapeHtml(s)}</span>`)
    .join("")}</div>`;
}

/**
 * Connected-apps list rows in the order the endpoint returns them (it
 * guarantees newest-first). `[]` → `""` — the caller decides the empty-state
 * text and hides the list, same branching `renderSessionsHtml` uses.
 */
export function renderConnectedAppsHtml(grants: ConnectedAppGrant[]): string {
  if (!grants.length) return "";
  return grants
    .map((grant) => {
      const name = grant.clientName || grant.clientId;
      const workspace = connectedAppWorkspaceLabel(grant.referenceId);
      const granted = grant.createdAt ? formatSessionTime(grant.createdAt) : "—";
      const badge =
        grant.activeTokenCount > 0
          ? `<span class="ul-badge ul-badge--ok">Active</span>`
          : `<span class="ul-badge">No active tokens</span>`;
      const icon =
        grant.clientIcon && /^https?:\/\//.test(grant.clientIcon)
          ? `<img src="${escapeHtml(grant.clientIcon)}" alt="" class="detail-icon" width="14" height="14" />`
          : "";
      return `<li>
            <div class="detail-main">
              <div class="detail-title">
                ${icon}
                <span>${escapeHtml(name)}</span>
                ${badge}
              </div>
              <div class="detail-meta">${escapeHtml(workspace)} · Granted ${escapeHtml(granted)}</div>
              ${scopeChipsHtml(grant.scopes)}
            </div>
            <div class="detail-action">
              <button type="button" class="text-btn" data-revoke="${escapeHtml(grant.id)}">Revoke</button>
            </div>
          </li>`;
    })
    .join("");
}
