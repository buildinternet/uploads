/**
 * Shared markup for /account/developers so SSR and the client swap the same
 * token-list rows. Keep this next to any placeholder that occupies the list.
 */
import {
  listIssuedWorkspaceTokens,
  listMintableWorkspaces,
  type IssuedWorkspaceToken,
  type MintableWorkspace,
} from "./api-client";
import { escapeHtml, renderEmptyStateHtml } from "./workspace-ui";

export async function loadDevelopersPageData(
  apiOrigin: string,
  cookie: string,
  fetchImpl?: typeof fetch,
): Promise<{ workspaces: MintableWorkspace[] | null; tokens: IssuedWorkspaceToken[] | null }> {
  if (!cookie.trim()) return { workspaces: null, tokens: null };
  const [workspaces, tokens] = await Promise.all([
    listMintableWorkspaces(apiOrigin, { cookie, fetchImpl }),
    listIssuedWorkspaceTokens(apiOrigin, { cookie, fetchImpl }),
  ]);
  return { workspaces, tokens };
}

export function formatTokenWhen(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

/** Short access label. Default read+write stays quiet; read-only is called out. */
export function tokenAccessLabel(scopes: string[]): string {
  const files = scopes.filter((scope) => scope.startsWith("files:"));
  if (files.length === 1 && files[0] === "files:read") return "read-only";
  return "";
}

export function renderIssuedTokenListHtml(tokens: IssuedWorkspaceToken[]): string {
  if (tokens.length === 0) {
    return `<li>${renderEmptyStateHtml({
      title: "No tokens yet",
      description: "Create one above to start.",
      variant: "inline",
    })}</li>`;
  }
  return tokens
    .map((token) => {
      const title = escapeHtml(token.label || "Untitled");
      const workspace = escapeHtml(token.workspace);
      const created = formatTokenWhen(token.createdAt);
      const expires = formatTokenWhen(token.expiresAt);
      const used = formatTokenWhen(token.lastUsedAt);
      const access = tokenAccessLabel(token.scopes);
      const meta = [
        workspace,
        access,
        created ? `created ${created}` : "",
        expires ? `expires ${expires}` : "no expiry",
        used ? `last used ${used}` : "never used",
      ]
        .filter(Boolean)
        .join(" · ");
      return `<li data-token-id="${escapeHtml(token.id)}"><div class="detail-main"><div class="detail-title">${title}</div><div class="detail-meta">${meta}</div></div><button type="button" class="text-btn" data-revoke="${escapeHtml(token.id)}" data-revoke-label="${title}" data-revoke-workspace="${workspace}">Revoke</button></li>`;
    })
    .join("");
}

export function renderWorkspaceOptionsHtml(names: string[]): string {
  return names
    .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
    .join("");
}
