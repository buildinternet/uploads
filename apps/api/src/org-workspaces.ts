/**
 * Org <-> workspace indirection (plan D4, Phase 3).
 *
 * Today an "org" (a Better Auth `organization` row, owned by the auth
 * worker's D1) maps 1:1 onto a "workspace" (a KV `ws:<name>` record, owned by
 * this worker) by `organization.slug === workspace name`. That 1:1 mapping is
 * an implementation detail of this module only — every other org<->workspace
 * lookup in apps/api MUST go through `orgForWorkspace`/`workspacesForOrg`
 * rather than assuming the slug equals the workspace name directly. If a
 * future org ever owns more than one workspace, this module is the only file
 * that needs to change (e.g. to consult a join table instead of doing a
 * pass-through slug lookup) — callers keep working unmodified.
 *
 * All lookups go through the `AUTH` service binding's internal API (never a
 * direct D1 read — this worker has no D1 binding into the auth worker's
 * database, by design, see plan D1's "ownership boundary").
 */

export interface OrgSummary {
  id: string;
  slug: string;
  name: string;
}

const INTERNAL_ORIGIN = "https://auth.internal";

function internalHeaders(): Headers {
  return new Headers({ "x-uploads-internal": "1" });
}

/**
 * The organization for a given workspace name, or null if none exists yet
 * (e.g. the workspace predates the Phase 3 backfill, or was never
 * provisioned as an org). Today: `GET /internal/orgs/:slug` with
 * `slug = workspace name`.
 */
export async function orgForWorkspace(env: Env, workspaceName: string): Promise<OrgSummary | null> {
  const response = await env.AUTH.fetch(
    `${INTERNAL_ORIGIN}/internal/orgs/${encodeURIComponent(workspaceName)}`,
    { headers: internalHeaders() },
  );
  if (response.status === 404) return null;
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as { organization?: OrgSummary } | null;
  return body?.organization ?? null;
}

/**
 * Workspace names an org grants access to. Today: exactly `[org.slug]` (1:1)
 * — this is intentionally NOT `[orgIdOrSlug]` verbatim, since the input may
 * be an id; resolving through the org record keeps the contract stable if
 * the mapping ever becomes one-to-many.
 */
export async function workspacesForOrg(env: Env, orgIdOrSlug: string): Promise<string[]> {
  // Today's org records are looked up by slug on the auth worker; when the
  // input is already a slug this is a single round trip. If a caller passes
  // an id instead, this still resolves via the same endpoint since
  // organization.slug is unique and ids/slugs never collide in this schema —
  // callers of this module should prefer passing the slug they already have.
  const org = await orgForWorkspace(env, orgIdOrSlug);
  return org ? [org.slug] : [];
}
