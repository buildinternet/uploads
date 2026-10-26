/**
 * Static drift guard between three independent descriptions of the public
 * API (issue #829 §1): the routes actually registered on the Hono `app`
 * (`app.routes`), the OpenAPI document served at
 * `apps/web/public/.well-known/openapi.json`, and the narrative reference in
 * `docs/api.md`. Deterministic — no network, no fixtures — so it fails the
 * moment a public route is added, renamed, or removed without updating both
 * docs.
 *
 * Scope: every `/v1/workspaces/...` and `/public/...` route. Each one is
 * either public (documented in both places) or listed in `INTERNAL_PREFIXES`
 * / `KNOWN_UNDOCUMENTED` with a reason, so a new route has to be classified
 * on purpose. The OpenAPI document is the public contract a typed SDK is
 * built from; internal routes can change without notice. The legacy
 * `/v1/:workspace/...` bearer-only alias family is excluded: `docs/api.md`'s
 * "Compatibility routes" section documents that whole family by convention,
 * and the OpenAPI document does the same (see its description field).
 * `/me`, `/admin`, `/internal` and the other top-level families are internal
 * by construction and never enter scope.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { app } from "./index";

interface OpenApiDoc {
  paths: Record<string, Record<string, unknown>>;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

const openapiPath = join(import.meta.dirname, "../../web/public/.well-known/openapi.json");
const apiMdPath = join(import.meta.dirname, "../../../docs/api.md");

const openapi = JSON.parse(readFileSync(openapiPath, "utf8")) as OpenApiDoc;
const apiMd = readFileSync(apiMdPath, "utf8");

/**
 * Hono param syntax (`:workspace`, `:key{.+}`) -> OpenAPI path templates
 * (`{workspace}`, `{key}`), then every `{name}` collapses to `{param}` — the
 * two documents don't always spell a path param the same way (e.g. this
 * router's `:id` vs. the OpenAPI document's `{galleryId}`), and this guard
 * cares about route shape, not param naming.
 */
function toComparablePath(honoOrOpenApiPath: string): string {
  return honoOrOpenApiPath
    .replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?/g, "{$1}")
    .replace(/\{[A-Za-z0-9_]+\}/g, "{param}");
}

const WS = "/v1/workspaces/:workspace";

/**
 * In-scope route families that stay out of the public API. A prefix covers
 * the path itself and everything under it.
 */
const INTERNAL_PREFIXES: Record<string, string> = {
  // Workspace settings and account management: session-only or web-app
  // shaped, managed from uploads.sh rather than through an SDK.
  [`${WS}/billing`]: "web billing page",
  [`${WS}/classifier-settings`]: "workspace settings page",
  [`${WS}/comment-preview`]: "workspace settings page",
  [`${WS}/comment-settings`]: "workspace settings page",
  [`${WS}/poster-settings`]: "workspace settings page",
  [`${WS}/invite-links`]: "member management",
  [`${WS}/invites`]: "member management",
  [`${WS}/members`]: "member management",
  [`${WS}/people`]: "member management",
  [`${WS}/service-tokens`]: "service tokens are minted from a signed-in session",
  [`${WS}/storage`]: "bring-your-own bucket setup",
  [`${WS}/summary`]: "web dashboard summary",
  [`${WS}/file-browser`]: "files-sdk folder browser for the web app",
  [`${WS}/restore`]: "workspace lifecycle",
  [`${WS}/tokens`]: "workspace lifecycle",
  // CLI and GitHub App plumbing. Only `github/comment` is public.
  [`${WS}/github/activity`]: "CLI GitHub plumbing",
  [`${WS}/github/attach`]: "CLI GitHub plumbing",
  [`${WS}/github/branch-rename`]: "CLI GitHub plumbing",
  [`${WS}/github/health`]: "CLI GitHub plumbing",
  [`${WS}/github/ingest`]: "CLI GitHub plumbing",
  [`${WS}/github/link`]: "CLI GitHub plumbing",
  [`${WS}/github/private-prefix`]: "CLI GitHub plumbing",
  [`${WS}/github/promote`]: "CLI GitHub plumbing",
  [`${WS}/github/repo-link`]: "CLI GitHub plumbing",
  [`${WS}/github/repo-links`]: "CLI GitHub plumbing",
  [`${WS}/github/status`]: "CLI GitHub plumbing",
  [`${WS}/github/titles`]: "CLI GitHub plumbing",
  "/public/github/avatars": "avatar proxy for the web app",
};

/** Exact in-scope routes that stay out of the public API, with the reason inline. */
const KNOWN_UNDOCUMENTED = new Set<string>([
  // Soft-deletes a whole workspace; an owner does that from the web app.
  "delete /v1/workspaces/{param}",
]);

const internalPrefixes = Object.keys(INTERNAL_PREFIXES).map(toComparablePath);

function isInScope(comparablePath: string): boolean {
  if (!comparablePath.startsWith("/v1/workspaces/") && !comparablePath.startsWith("/public/"))
    return false;
  return !internalPrefixes.some(
    (prefix) => comparablePath === prefix || comparablePath.startsWith(`${prefix}/`),
  );
}

/**
 * Public routes registered on the live app, as "method comparable-path"
 * strings. A Hono `.all(...)` route (method `ALL`) expands to one entry per
 * HTTP method, matching how a real client request actually reaches it.
 */
function publicRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const route of app.routes) {
    const path = toComparablePath(route.path);
    if (!isInScope(path)) continue;
    const methods =
      route.method.toLowerCase() === "all" ? HTTP_METHODS : [route.method.toLowerCase()];
    for (const method of methods) {
      if (!HTTP_METHODS.includes(method)) continue;
      const entry = `${method} ${path}`;
      if (!KNOWN_UNDOCUMENTED.has(entry)) routes.add(entry);
    }
  }
  return routes;
}

function openApiRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const [path, methods] of Object.entries(openapi.paths)) {
    for (const method of Object.keys(methods)) {
      if (!HTTP_METHODS.includes(method)) continue; // skips the sibling "parameters" key
      routes.add(`${method} ${toComparablePath(path)}`);
    }
  }
  return routes;
}

function registeredComparable(): Set<string> {
  return new Set(app.routes.map((route) => toComparablePath(route.path)));
}

describe("openapi.json vs. registered routes", () => {
  it("documents every public route", () => {
    const documented = openApiRoutes();
    const missing = [...publicRoutes()].filter((route) => !documented.has(route));
    expect(missing).toEqual([]);
  });

  it("has no stale paths — every documented route is a registered public route", () => {
    const registered = publicRoutes();
    const stale = [...openApiRoutes()].filter((route) => !registered.has(route));
    expect(stale).toEqual([]);
  });

  it("has no stale exceptions — every internal entry still matches a real route", () => {
    const paths = registeredComparable();
    const stalePrefixes = internalPrefixes.filter(
      (prefix) => ![...paths].some((path) => path === prefix || path.startsWith(`${prefix}/`)),
    );
    const staleRoutes = [...KNOWN_UNDOCUMENTED].filter(
      (entry) => !paths.has(entry.slice(entry.indexOf(" ") + 1)),
    );
    expect([...stalePrefixes, ...staleRoutes]).toEqual([]);
  });
});

describe("docs/api.md vs. registered public routes", () => {
  it("mentions every public route's literal path at least once", () => {
    // Param *names* legitimately differ between the route source and the
    // prose (`:item` vs. `:itemId`); normalize both sides to `:param` before
    // substring-matching so this checks path *shape*, not naming.
    const normalizedApiMd = apiMd.replace(/:([A-Za-z0-9_]+)/g, ":param");
    const toDocsPath = (honoPath: string) =>
      honoPath.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?/g, ":param");
    const publicPaths = new Set([...publicRoutes()].map((route) => route.split(" ")[1]));
    const missing = [
      ...new Set(
        app.routes
          .map((route) => route.path)
          .filter((path) => publicPaths.has(toComparablePath(path))),
      ),
    ].filter((path) => !normalizedApiMd.includes(toDocsPath(path)));
    expect(missing).toEqual([]);
  });
});
