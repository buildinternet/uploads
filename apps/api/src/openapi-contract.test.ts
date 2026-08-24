/**
 * Static drift guard between three independent descriptions of the public
 * API (issue #829 §1): the routes actually registered on the Hono `app`
 * (`app.routes`), the OpenAPI document served at
 * `apps/web/public/.well-known/openapi.json`, and the narrative reference in
 * `docs/api.md`. Deterministic — no network, no fixtures — so it fails the
 * moment a canonical route is added, renamed, or removed without updating
 * both docs.
 *
 * Scope: the canonical `/v1/workspaces/:workspace/files...`, `/usage...`,
 * and `/galleries...` verticals (issue #829 §1), plus
 * `/public/galleries/:id`. These are the token-authable "public developer
 * API" surface documented in `docs/api.md`'s "Canonical routes" table. The
 * canonical `github`/`members`/`storage`/`billing`/`comment-settings`
 * verticals (issue #613 phases 2-3) are mostly session-only account
 * management, covered by their own docs, and out of scope here — folding
 * them in is tracked separately, not silently expanded into this guard. The
 * legacy `/v1/:workspace/...` bearer-only alias family is also excluded:
 * `docs/api.md`'s "Compatibility routes" section documents that whole family
 * by convention rather than path by path, and the OpenAPI document does the
 * same (see its description field). `KNOWN_UNDOCUMENTED` below is the
 * explicit, reasoned exception list for in-scope routes that stay out of the
 * OpenAPI document on purpose.
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

/** Path prefixes under `/v1/workspaces/:workspace/` that are in scope — see the module docblock. */
const IN_SCOPE_VERTICALS = ["files", "usage", "galleries"];

/**
 * Canonical public-API routes registered on the live app, restricted to the
 * files/usage/galleries verticals and the one public gallery read. Each is a
 * "METHOD comparable-path" string. A Hono `.all(...)` route (method `ALL`)
 * expands to one entry per HTTP method, matching how a real client request
 * actually reaches it.
 */
function canonicalRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const route of app.routes) {
    const path = route.path;
    const isPublicGallery = path === "/public/galleries/:id";
    const isInScopeWorkspaceRoute = IN_SCOPE_VERTICALS.some(
      (vertical) =>
        path === `/v1/workspaces/:workspace/${vertical}` ||
        path.startsWith(`/v1/workspaces/:workspace/${vertical}/`),
    );
    if (!isInScopeWorkspaceRoute && !isPublicGallery) continue;

    const methods =
      route.method.toLowerCase() === "all" ? HTTP_METHODS : [route.method.toLowerCase()];
    for (const method of methods) {
      if (!HTTP_METHODS.includes(method)) continue;
      routes.add(`${method} ${toComparablePath(path)}`);
    }
  }
  return routes;
}

/**
 * Registered in-scope routes that are deliberately absent from the OpenAPI
 * document, with the reason inline. Keep this list short — a new omission
 * should be a conscious decision, not a silent gap. Empty today: the
 * files-sdk folder-browser gateway (`/v1/workspaces/:workspace/file-browser`)
 * is a sibling of the `files` vertical rather than a route under it, so it
 * never enters `canonicalRoutes()` in the first place and needs no entry
 * here.
 */
const KNOWN_UNDOCUMENTED = new Set<string>();

function openApiRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const [path, methods] of Object.entries(openapi.paths)) {
    if (!path.startsWith("/v1/workspaces/") && path !== "/public/galleries/{galleryId}") continue;
    for (const method of Object.keys(methods)) {
      if (!HTTP_METHODS.includes(method)) continue; // skips the sibling "parameters" key
      routes.add(`${method} ${toComparablePath(path)}`);
    }
  }
  return routes;
}

describe("openapi.json vs. registered canonical routes", () => {
  it("documents every registered canonical route (or lists it as a known exception)", () => {
    const registered = canonicalRoutes();
    const documented = openApiRoutes();
    const missing = [...registered].filter(
      (route) => !documented.has(route) && !KNOWN_UNDOCUMENTED.has(route),
    );
    expect(missing).toEqual([]);
  });

  it("has no stale exceptions — every KNOWN_UNDOCUMENTED entry is still a real route", () => {
    const registered = canonicalRoutes();
    const stale = [...KNOWN_UNDOCUMENTED].filter((route) => !registered.has(route));
    expect(stale).toEqual([]);
  });

  it("has no stale paths — every documented in-scope route still exists on the app", () => {
    const registered = canonicalRoutes();
    const documented = openApiRoutes();
    const stale = [...documented].filter((route) => !registered.has(route));
    expect(stale).toEqual([]);
  });
});

describe("docs/api.md vs. registered canonical routes", () => {
  it("mentions every registered canonical route's literal path at least once", () => {
    const registered = new Set<string>();
    for (const route of app.routes) {
      const path = route.path;
      const isPublicGallery = path === "/public/galleries/:id";
      const isInScopeWorkspaceRoute = IN_SCOPE_VERTICALS.some(
        (vertical) =>
          path === `/v1/workspaces/:workspace/${vertical}` ||
          path.startsWith(`/v1/workspaces/:workspace/${vertical}/`),
      );
      if (isInScopeWorkspaceRoute || isPublicGallery) registered.add(path);
    }

    const undocumentedComparable = new Set(
      [...KNOWN_UNDOCUMENTED].map((route) => route.split(" ")[1]),
    );
    // Param *names* legitimately differ between the route source and the
    // prose (`:item` vs. `:itemId`); normalize both sides to `:param` before
    // substring-matching so this checks path *shape*, not naming.
    const normalizedApiMd = apiMd.replace(/:([A-Za-z0-9_]+)/g, ":param");
    const toDocsPath = (honoPath: string) =>
      honoPath.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?/g, ":param");
    const missing = [...registered].filter(
      (path) =>
        !undocumentedComparable.has(toComparablePath(path)) &&
        !normalizedApiMd.includes(toDocsPath(path)),
    );
    expect(missing).toEqual([]);
  });
});
