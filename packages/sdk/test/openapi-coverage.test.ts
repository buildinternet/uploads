/**
 * Drift guard between the SDK and the public OpenAPI document
 * (`apps/web/public/.well-known/openapi.json`). Every SDK method is called
 * against a fake fetch and the routes it hits are matched to the document,
 * so the SDK can't call an undocumented route, and every documented
 * operation is either reached by some SDK method or listed in
 * `NOT_IN_SDK` with a reason. A new public route (or SDK method) has to be
 * classified on purpose.
 */
import { describe, expect, it } from "vitest";
import spec from "../../../apps/web/public/.well-known/openapi.json" with { type: "json" };
import { createUploadsClient, type UploadsClient } from "../src/index.js";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

/** Documented operations the SDK doesn't wrap yet. Callers can use `request`. */
const NOT_IN_SDK: Record<string, string> = {
  "POST /v1/workspaces/{workspace}/files/sign": "signed read URLs",
  "GET /v1/workspaces/{workspace}/files/by-path": "screenshots by path",
  "GET /v1/workspaces/{workspace}/files/file-url": "signed read URLs",
  "PATCH /v1/workspaces/{workspace}/files/visibility": "file visibility",
  "GET /v1/workspaces/{workspace}/files/held/download": "held file bytes",
  "POST /v1/workspaces/{workspace}/files/hold": "hold for review again",
  "GET /v1/workspaces/{workspace}/files/review": "review history",
  "PATCH /v1/workspaces/{workspace}/galleries/{galleryId}": "gallery editing",
  "PUT /v1/workspaces/{workspace}/galleries/{galleryId}/items/order": "gallery editing",
  "DELETE /v1/workspaces/{workspace}/galleries/{galleryId}/items/{itemId}": "gallery editing",
  "GET /v1/workspaces/{workspace}/pulls": "PR and repo browsing",
  "GET /v1/workspaces/{workspace}/repos": "PR and repo browsing",
  "GET /v1/workspaces/{workspace}/scope/{owner}/{repo}/files": "PR and repo browsing",
  "GET /public/files/{workspace}/{key}": "public reads need no token",
  "GET /public/galleries/{galleryId}": "public reads need no token",
  "GET /public/galleries/{galleryId}/items/{itemId}/download": "public reads need no token",
  "GET /public/feeds/{feedId}": "public reads need no token",
  "GET /public/feeds/{feedId}/items/{itemId}": "public reads need no token",
};

type MethodName = Exclude<keyof UploadsClient, "request">;

/** One representative call per SDK method. Keys avoid `/` so `{key}` matches one segment. */
const CALLS: Record<MethodName, (c: UploadsClient) => Promise<unknown>> = {
  put: (c) => c.put("k.png", new Uint8Array([1])),
  previewPut: (c) => c.previewPut("k.png"),
  list: (c) => c.list(),
  listAll: (c) => c.listAll(),
  head: (c) => c.head("k.png"),
  delete: (c) => c.delete("k.png"),
  listHeld: (c) => c.listHeld(),
  approve: (c) => c.approve("k.png"),
  getMetadata: (c) => c.getMetadata("k.png"),
  patchMetadata: (c) => c.patchMetadata("k.png", { set: { a: "b" } }),
  findFiles: (c) => c.findFiles({ a: "b" }),
  findFilesAll: (c) => c.findFilesAll({ a: "b" }),
  listMetadataKeys: (c) => c.listMetadataKeys(),
  listMetadataValues: (c) => c.listMetadataValues("a"),
  createGallery: (c) => c.createGallery({ title: "t" }),
  getGallery: (c) => c.getGallery("g"),
  listGalleries: (c) => c.listGalleries(),
  deleteGallery: (c) => c.deleteGallery("g", {} as never),
  addGalleryItem: (c) => c.addGalleryItem("g", "k.png", {} as never),
  listGalleryExternalReferences: (c) => c.listGalleryExternalReferences("g"),
  linkGalleryExternalReference: (c) => c.linkGalleryExternalReference("g", {} as never),
  unlinkGalleryExternalReference: (c) => c.unlinkGalleryExternalReference("g", "r", {} as never),
  findGalleriesByReference: (c) =>
    c.findGalleriesByReference({ provider: "github", coordinate: "o/r#1" } as never),
  createFeed: (c) => c.createFeed({} as never),
  getFeed: (c) => c.getFeed("f"),
  listFeeds: (c) => c.listFeeds(),
  deleteFeed: (c) => c.deleteFeed("f"),
  upsertGithubComment: (c) => c.upsertGithubComment({ repo: "o/r", num: 1, kind: "pull" }),
  health: (c) => c.health(),
  usage: (c) => c.usage(),
  reconcile: (c) => c.reconcile(),
  purgeExpired: (c) => c.purgeExpired(),
};

const documented = Object.entries(spec.paths as Record<string, Record<string, unknown>>).flatMap(
  ([path, ops]) =>
    Object.keys(ops)
      .filter((m) => HTTP_METHODS.includes(m))
      .map((m) => ({
        id: `${m.toUpperCase()} ${path}`,
        method: m.toUpperCase(),
        params: (path.match(/\{/g) ?? []).length,
        re: new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`),
      })),
);

/** The documented operation a request hits, preferring literal segments over params. */
function operationFor(method: string, pathname: string): string | undefined {
  return documented
    .filter((op) => op.method === method && op.re.test(pathname))
    .sort((a, b) => a.params - b.params)[0]?.id;
}

const inScope = (pathname: string) =>
  pathname.startsWith("/v1/workspaces/") || pathname.startsWith("/public/");

async function routesHit(): Promise<Map<MethodName, Array<{ method: string; pathname: string }>>> {
  const hits = new Map<MethodName, Array<{ method: string; pathname: string }>>();
  for (const [name, call] of Object.entries(CALLS) as Array<
    [MethodName, (c: UploadsClient) => Promise<unknown>]
  >) {
    const seen: Array<{ method: string; pathname: string }> = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ method: init?.method ?? "GET", pathname: new URL(String(url)).pathname });
      // One body loose enough for every method's parser; `cursor: null` ends pagination.
      return Response.json({ files: [], items: [], cursor: null, url: "https://cdn.test/k.png" });
    }) as typeof globalThis.fetch;
    await call(
      createUploadsClient({ token: "t", workspace: "ws", apiUrl: "https://api.test" }, { fetch }),
    );
    hits.set(name, seen);
  }
  return hits;
}

describe("SDK coverage of the OpenAPI document", () => {
  it("has a representative call for every SDK method", () => {
    const client = createUploadsClient({ token: "t", workspace: "ws" });
    const methods = Object.keys(client).filter((k) => k !== "request");
    expect(methods.sort()).toEqual(Object.keys(CALLS).sort());
  });

  it("only calls documented routes", async () => {
    const undocumented: string[] = [];
    for (const [name, seen] of await routesHit()) {
      for (const { method, pathname } of seen) {
        if (inScope(pathname) && !operationFor(method, pathname)) {
          undocumented.push(`${name}: ${method} ${pathname}`);
        }
      }
    }
    expect(undocumented).toEqual([]);
  });

  it("wraps every documented operation or lists it in NOT_IN_SDK", async () => {
    const covered = new Set<string>();
    for (const seen of (await routesHit()).values()) {
      for (const { method, pathname } of seen) {
        const op = operationFor(method, pathname);
        if (op) covered.add(op);
      }
    }
    const missing = documented
      .map((op) => op.id)
      .filter((id) => !covered.has(id) && !(id in NOT_IN_SDK));
    expect(missing).toEqual([]);
    // Drop an entry once the SDK wraps the operation (or the route goes away).
    const stale = Object.keys(NOT_IN_SDK).filter(
      (id) => covered.has(id) || !documented.some((op) => op.id === id),
    );
    expect(stale).toEqual([]);
  });
});
