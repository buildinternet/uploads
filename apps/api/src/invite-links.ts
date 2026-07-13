/**
 * Shared invite-link URL helpers used by both the ADMIN_TOKEN-gated
 * POST /admin/enrollments path (routes/admin.ts) and the session-authed
 * POST /admin-ui/workspaces/:name/invite-links path (routes/admin-ui.ts).
 * Keeping this logic in one place avoids the two routes drifting apart.
 */

// The invite page lives on the web origin, which mirrors the API host without
// the `api.` prefix (api.uploads.sh -> uploads.sh), matching the CLI default.
export function deriveWebOrigin(requestUrl: string): string {
  const url = new URL(requestUrl);
  url.hostname = url.hostname.replace(/^api\./, "");
  return url.origin;
}

// Self-contained magic link: the single-use code rides in the URL fragment, which
// browsers never send to a server, so it stays out of logs and referrers.
export function inviteLinkUrl(webOrigin: string, pageId: string, code: string): string {
  return `${webOrigin}/invite?id=${encodeURIComponent(pageId)}#code=${encodeURIComponent(code)}`;
}
