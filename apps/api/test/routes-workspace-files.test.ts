/**
 * Canonical dual-auth files vertical (issue #613 phase 1):
 * `/v1/workspaces/:workspace/files*`. Exercised through the real composed
 * `app` (index.ts), not the sub-router directly, so this also proves the
 * `/v1/workspaces` mount (shared with the lifecycle router) resolves
 * correctly. Response-shape coverage for these handlers already lives in
 * `src/routes/me.test.ts` (session, ported verbatim) and
 * `test/routes-files.test.ts` (bearer, `DELETE /:key{.+}` shape); this file
 * is scoped to what's new: both credential types reaching the SAME handler,
 * and the auth rejections specific to the dual-auth guard.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Files } from "@uploads/storage";
import { FakeR2Bucket } from "./fake-r2";
import { FileMetadataTable } from "./helpers/fake-file-metadata-table";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";

// `resolveObjectLane` delegates to the real implementation everywhere except
// the one test below that needs an HTTP-mode fallback lane's signed URL
// without dialing out for a real S3 HEAD probe.
vi.mock("../src/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/storage")>();
  return { ...original, resolveObjectLane: vi.fn(original.resolveObjectLane) };
});

const { app } = await import("../src/index");
const storageModule = await import("../src/storage");

const TOKEN = "canonical-secret-token";
const USER = { id: "u-1", email: "member@example.com", name: "Member" };

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeAll(() => {
  if (!(crypto.subtle as SubtleCrypto & { timingSafeEqual?: unknown }).timingSafeEqual) {
    Object.defineProperty(crypto.subtle, "timingSafeEqual", {
      value: (left: ArrayBufferView, right: ArrayBufferView) => {
        const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
        const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
        if (a.length !== b.length) return false;
        let difference = 0;
        for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
        return difference === 0;
      },
    });
  }
});

function makeFakeDB() {
  const table = new FileMetadataTable();
  return {
    metadata: table.metadata,
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          args = values;
          return this;
        },
        async first() {
          return null;
        },
        async run() {
          return (
            table.tryRun(normalized, args) ?? { success: true, meta: { changes: 0 }, results: [] }
          );
        },
        async all<T>() {
          return (
            table.tryAll<T>(normalized, args) ?? { success: true, results: [] as T[], meta: {} }
          );
        },
      };
    },
    async batch(stmts: { run: () => Promise<unknown> }[]) {
      return Promise.all(stmts.map((s) => s.run()));
    },
  };
}

/**
 * Env wired for BOTH credential types against the same `acme` workspace: a
 * legacy bearer token (`tokenHash`) and — when `member` is true — a session
 * user with an `acme` org membership.
 */
async function makeEnv(
  opts: {
    member?: boolean;
    session?: boolean;
    getSessionCalls?: { count: number };
    recordOverrides?: Partial<WorkspaceRecord>;
    extraBindings?: Record<string, FakeR2Bucket>;
  } = {},
): Promise<{ env: Parameters<typeof app.request>[2]; bucket: FakeR2Bucket }> {
  const { member = true, session = true, getSessionCalls, recordOverrides, extraBindings } = opts;
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "uploads-default",
    binding: "UPLOADS_DEFAULT",
    prefix: "acme/",
    publicBaseUrl: "https://storage.uploads.sh",
    tokenHash: await sha256Hex(TOKEN),
    ...recordOverrides,
  };
  const bucket = new FakeR2Bucket();
  const db = makeFakeDB();
  const env = {
    REGISTRY: {
      get: async (key: string) => (key === "ws:acme" ? record : null),
    },
    UPLOADS_DEFAULT: bucket,
    ...extraBindings,
    DB: db,
    WRITE_LIMITER: { limit: async () => ({ success: true }) },
    WEB_ORIGIN: "https://uploads.sh",
    GITHUB_CACHE: { get: async () => null, put: async () => undefined },
    AUTH: {
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.pathname === "/api/auth/get-session") {
          if (getSessionCalls) getSessionCalls.count++;
          return session ? Response.json({ session: {}, user: USER }) : Response.json(null);
        }
        if (url.pathname === "/internal/memberships") {
          return Response.json(
            member
              ? [
                  {
                    organizationId: "org-1",
                    organizationSlug: "acme",
                    organizationName: "Acme",
                    role: "member",
                  },
                ]
              : [],
          );
        }
        return new Response(JSON.stringify({ githubAccountId: null }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  };
  return { env: env as unknown as Parameters<typeof app.request>[2], bucket };
}

async function seed(bucket: FakeR2Bucket) {
  await bucket.put("acme/shots/a.png", new Uint8Array([1, 2, 3]).buffer, {
    httpMetadata: { contentType: "image/png" },
  });
}

describe("GET /v1/workspaces/:workspace/files (dual auth)", () => {
  it("accepts a bearer token", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket);
    const res = await app.request(
      "/v1/workspaces/acme/files",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { key: string }[] };
    expect(body.files.map((f) => f.key)).toEqual(["shots/a.png"]);
  });

  it("accepts a session cookie for a member workspace", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket);
    const res = await app.request(
      "/v1/workspaces/acme/files",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { key: string }[] };
    expect(body.files.map((f) => f.key)).toEqual(["shots/a.png"]);
  });

  it("401s a bearer token whose hash doesn't match this workspace (token-workspace mismatch)", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/files",
      { headers: { Authorization: "Bearer wrong-token" } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("404s a signed-in caller who isn't a member of the workspace (uniform workspace_not_found)", async () => {
    const { env } = await makeEnv({ member: false });
    const res = await app.request(
      "/v1/workspaces/acme/files",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("workspace_not_found");
  });

  it("401s with neither a bearer token nor a session cookie", async () => {
    const { env } = await makeEnv({ session: false });
    const res = await app.request("/v1/workspaces/acme/files", {}, env);
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/workspaces/:workspace/files/file-url (dual auth)", () => {
  it("resolves the public URL for a bearer caller", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket);
    const res = await app.request(
      "/v1/workspaces/acme/files/file-url?key=shots/a.png",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://storage.uploads.sh/acme/shots/a.png" });
  });

  it("resolves the public URL for a session caller identically", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket);
    const res = await app.request(
      "/v1/workspaces/acme/files/file-url?key=shots/a.png",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://storage.uploads.sh/acme/shots/a.png" });
  });

  // Task C2 (two-lane storage, PR C): a key that only exists in a fallback
  // lane (e.g. detached BYO storage that still holds objects) resolves to
  // that lane's own public URL, not a 404 against the active lane.
  it("resolves a fallback-only key to the fallback lane's public URL", async () => {
    const fallbackBucket = new FakeR2Bucket();
    await fallbackBucket.put("legacy/shots/old.png", new Uint8Array([9]).buffer);
    const { env } = await makeEnv({
      recordOverrides: {
        storageLaneId: "lane_active1",
        storageLanes: [
          {
            id: "lane_fallback1",
            provider: "r2",
            bucket: "customer-bucket",
            binding: "UPLOADS_FALLBACK",
            prefix: "legacy/",
            lastActiveAt: "2026-08-01T00:00:00.000Z",
            publicBaseUrl: "https://storage.customer.example.com",
          },
        ],
      },
      extraBindings: { UPLOADS_FALLBACK: fallbackBucket },
    });
    const res = await app.request(
      "/v1/workspaces/acme/files/file-url?key=shots/old.png",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: "https://storage.customer.example.com/legacy/shots/old.png",
    });
  });

  // A fallback lane without a public URL (HTTP-credential mode) must still
  // resolve — via a signed URL minted from that owning lane's store, not the
  // active lane's. `resolveObjectLane` itself is proven lane-aware by
  // storage-lanes.test.ts; this stubs it to hand the route a fallback
  // `ResolvedLane` directly, so the route's "sign against the *owning* lane"
  // wiring is exercised without a real S3 HEAD probe over the network.
  it("mints a signed URL from the owning fallback lane when it has no publicBaseUrl", async () => {
    const fallbackStore = {
      capabilities: { signedUrl: { supported: true } },
      url: vi.fn(async (key: string) => `https://customer-bucket.example.com/signed/${key}`),
    } as unknown as Files;
    vi.mocked(storageModule.resolveObjectLane).mockResolvedValueOnce({
      store: fallbackStore,
      // No publicBaseUrl — HTTP-credential mode, must sign instead.
      config: { provider: "r2", bucket: "customer-bucket" } as never,
      laneId: "lane_fallback1",
      role: "fallback",
    });
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/files/file-url?key=shots/old.png",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    // Not the active lane's public base, and not a plain unsigned URL.
    expect(body.url).not.toContain("storage.uploads.sh");
    expect(body.url).toBe("https://customer-bucket.example.com/signed/shots/old.png");
    expect(fallbackStore.url).toHaveBeenCalledWith(
      "shots/old.png",
      expect.objectContaining({ responseContentDisposition: "attachment" }),
    );
  });
});

describe("PATCH /v1/workspaces/:workspace/files/visibility (dual auth)", () => {
  it("flips visibility for a bearer caller", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket);
    const res = await app.request(
      "/v1/workspaces/acme/files/visibility?key=shots/a.png",
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ visibility: "private" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "shots/a.png", visibility: "private" });
  });

  it("flips visibility for a session caller", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket);
    const res = await app.request(
      "/v1/workspaces/acme/files/visibility?key=shots/a.png",
      {
        method: "PATCH",
        headers: { cookie: "session=x", "content-type": "application/json" },
        body: JSON.stringify({ visibility: "private" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "shots/a.png", visibility: "private" });
  });
});

describe("DELETE /v1/workspaces/:workspace/files/:key (dual auth, path-keyed)", () => {
  it("deletes for a bearer caller", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket);
    const res = await app.request(
      "/v1/workspaces/acme/files/shots/a.png",
      { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "shots/a.png", deleted: true });
    expect(await bucket.head("acme/shots/a.png")).toBeNull();
  });

  it("deletes for a session caller", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket);
    const res = await app.request(
      "/v1/workspaces/acme/files/shots/a.png",
      { method: "DELETE", headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "shots/a.png", deleted: true });
  });

  it("404s a non-member's delete attempt without deleting the object", async () => {
    const { env, bucket } = await makeEnv({ member: false });
    await seed(bucket);
    const res = await app.request(
      "/v1/workspaces/acme/files/shots/a.png",
      { method: "DELETE", headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(404);
    expect(await bucket.head("acme/shots/a.png")).not.toBeNull();
  });
});

describe("GET /v1/workspaces/:workspace/files/facets and /search (dual auth)", () => {
  it("facets: both credential types reach the same 200 shape", async () => {
    const { env } = await makeEnv();
    const bearer = await app.request(
      "/v1/workspaces/acme/files/facets",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const session = await app.request(
      "/v1/workspaces/acme/files/facets",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(bearer.status).toBe(200);
    expect(session.status).toBe(200);
    expect(await bearer.json()).toEqual(await session.json());
  });

  it("search: requires at least one meta.* filter or name for both credential types", async () => {
    const { env } = await makeEnv();
    const bearer = await app.request(
      "/v1/workspaces/acme/files/search",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    const session = await app.request(
      "/v1/workspaces/acme/files/search",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(bearer.status).toBe(400);
    expect(session.status).toBe(400);
  });

  it("search: ?limit= narrows the page and reports truncation", async () => {
    const { env, bucket } = await makeEnv();
    await bucket.put("acme/shots/hero-a.png", new Uint8Array([1]).buffer, {
      httpMetadata: { contentType: "image/png" },
    });
    await bucket.put("acme/shots/hero-b.png", new Uint8Array([1]).buffer, {
      httpMetadata: { contentType: "image/png" },
    });
    const res = await app.request(
      "/v1/workspaces/acme/files/search?name=hero&limit=1",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; truncated: boolean };
    expect(body.items).toHaveLength(1);
    expect(body.truncated).toBe(true);
  });
});

/**
 * Cursor pagination for the two search paths (issue #829 §4). `cursor` is the
 * additive continuation field; `items`/`truncated` keep their meaning.
 */
describe("GET /v1/workspaces/:workspace/files/search cursor pagination", () => {
  type SearchBody = { items: { key: string }[]; truncated: boolean; cursor: string | null };

  async function search(env: Parameters<typeof app.request>[2], qs: string): Promise<SearchBody> {
    const res = await app.request(
      `/v1/workspaces/acme/files/search?${qs}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as SearchBody;
  }

  function seedMeta(env: Parameters<typeof app.request>[2], key: string, app_: string): void {
    const table = (env as { DB: { metadata: Map<string, Map<string, string>> } }).DB;
    table.metadata.set(`acme ${key}`, new Map([["app", app_]]));
  }

  it("name path: walks the whole result set one page at a time without repeats", async () => {
    const { env, bucket } = await makeEnv();
    for (const name of ["hero-a", "hero-b", "hero-c"]) {
      await bucket.put(`acme/shots/${name}.png`, new Uint8Array([1]).buffer, {
        httpMetadata: { contentType: "image/png" },
      });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const body: SearchBody = await search(
        env,
        `name=hero&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...body.items.map((item) => item.key));
      // The continuation is present exactly when the page was truncated.
      expect(body.cursor === null).toBe(!body.truncated);
      cursor = body.cursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(["shots/hero-a.png", "shots/hero-b.png", "shots/hero-c.png"]);
  });

  it("metadata path: keyset continuation walks matching rows once", async () => {
    const { env } = await makeEnv();
    seedMeta(env, "shots/one.png", "web");
    seedMeta(env, "shots/two.png", "web");
    seedMeta(env, "shots/three.png", "web");
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const body: SearchBody = await search(
        env,
        `meta.app=web&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...body.items.map((item) => item.key));
      cursor = body.cursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect([...seen].sort()).toEqual(["shots/one.png", "shots/three.png", "shots/two.png"]);
  });

  it("metadata path: advances even when the name term drops the whole window", async () => {
    const { env } = await makeEnv();
    seedMeta(env, "shots/aaa.png", "web");
    seedMeta(env, "shots/bbb.png", "web");
    seedMeta(env, "shots/zzz-hero.png", "web");
    // Page 1's D1 window holds only `aaa`, which the name term drops — but the
    // page is still truncated and its cursor moves past `aaa`.
    const first = await search(env, "meta.app=web&name=hero&limit=1");
    expect(first.items).toEqual([]);
    expect(first.truncated).toBe(true);
    expect(first.cursor).not.toBeNull();

    const keys: string[] = [];
    let cursor: string | null = first.cursor;
    for (let page = 0; page < 5 && cursor; page += 1) {
      const body: SearchBody = await search(
        env,
        `meta.app=web&name=hero&limit=1&cursor=${encodeURIComponent(cursor)}`,
      );
      keys.push(...body.items.map((item) => item.key));
      cursor = body.cursor;
    }
    expect(keys).toEqual(["shots/zzz-hero.png"]);
  });

  it("treats an empty ?cursor= as absent rather than a malformed cursor", async () => {
    const { env, bucket } = await makeEnv();
    await bucket.put("acme/shots/hero-a.png", new Uint8Array([1]).buffer, {
      httpMetadata: { contentType: "image/png" },
    });
    seedMeta(env, "shots/hero-a.png", "web");
    // Hono yields "" (not undefined) for a bare `?cursor=`, so both paths have
    // to read it as "no cursor supplied" instead of failing the decode.
    const named = await search(env, "name=hero&cursor=");
    expect(named.items.map((item) => item.key)).toEqual(["shots/hero-a.png"]);
    const meta = await search(env, "meta.app=web&cursor=");
    expect(meta.items.map((item) => item.key)).toEqual(["shots/hero-a.png"]);
  });

  it("rejects a cursor replayed against a different filter set", async () => {
    const { env } = await makeEnv();
    seedMeta(env, "shots/one.png", "web");
    seedMeta(env, "shots/two.png", "web");
    seedMeta(env, "shots/three.png", "docs");
    const page = await search(env, "meta.app=web&limit=1");
    expect(page.cursor).not.toBeNull();
    // Same path, different query: resuming here would skip keys sorting before
    // the previous query's stopping point without telling the caller.
    const res = await app.request(
      `/v1/workspaces/acme/files/search?meta.app=docs&cursor=${encodeURIComponent(page.cursor!)}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "file_search_invalid_cursor",
    );
  });

  it("pages with collapse=promoted, which binds the workspace twice", async () => {
    const { env } = await makeEnv();
    const table = (env as { DB: { metadata: Map<string, Map<string, string>> } }).DB;
    for (const key of ["shots/one.png", "shots/two.png", "shots/three.png"]) {
      table.metadata.set(`acme ${key}`, new Map([["app", "web"]]));
    }
    table.metadata.set(
      "acme shots/promoted.png",
      new Map([
        ["app", "web"],
        ["gh.status", "promoted"],
      ]),
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      const body: SearchBody = await search(
        env,
        `meta.app=web&collapse=promoted&limit=1${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`,
      );
      seen.push(...body.items.map((item) => item.key));
      cursor = body.cursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    // The promoted shadow stays excluded on every page, and nothing repeats.
    expect([...seen].sort()).toEqual(["shots/one.png", "shots/three.png", "shots/two.png"]);
  });

  it("rejects a garbage cursor and one minted for the other search path", async () => {
    const { env, bucket } = await makeEnv();
    await bucket.put("acme/shots/hero-a.png", new Uint8Array([1]).buffer, {
      httpMetadata: { contentType: "image/png" },
    });
    await bucket.put("acme/shots/hero-b.png", new Uint8Array([1]).buffer, {
      httpMetadata: { contentType: "image/png" },
    });
    seedMeta(env, "shots/hero-a.png", "web");
    seedMeta(env, "shots/hero-b.png", "web");

    const garbage = await app.request(
      "/v1/workspaces/acme/files/search?name=hero&cursor=not-a-cursor",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(garbage.status).toBe(400);
    expect(((await garbage.json()) as { error: { code: string } }).error.code).toBe(
      "file_search_invalid_cursor",
    );

    // A metadata-path cursor must not be replayable against the name-only walk.
    const metaPage = await search(env, "meta.app=web&limit=1");
    expect(metaPage.cursor).not.toBeNull();
    const foreign = await app.request(
      `/v1/workspaces/acme/files/search?name=hero&cursor=${encodeURIComponent(metaPage.cursor!)}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe(
      "file_search_invalid_cursor",
    );
  });
});

describe("GET /v1/workspaces/:workspace/files/by-path (dual auth)", () => {
  it("bearer token: returns the grouped shape", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket);
    const res = await app.request(
      "/v1/workspaces/acme/files/by-path",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      groups: [],
      catalog: [],
      latest: [],
      projects: [],
      truncated: false,
      catalogTruncated: false,
    });
  });

  it("session cookie: reaches the same handler", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket);
    const res = await app.request(
      "/v1/workspaces/acme/files/by-path",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      groups: [],
      catalog: [],
      latest: [],
      projects: [],
      truncated: false,
      catalogTruncated: false,
    });
  });
});

describe("old-path aliases forward unchanged (issue #613)", () => {
  it("/me/workspaces/:name/file-url still returns the same shape as canonical", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket);
    const res = await app.request(
      "/me/workspaces/acme/file-url?key=shots/a.png",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://storage.uploads.sh/acme/shots/a.png" });
  });

  it("/v1/:workspace/files (bearer path) is untouched by the canonical mount", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket);
    const res = await app.request(
      "/v1/acme/files",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { key: string }[] };
    expect(body.items.map((i) => i.key)).toEqual(["shots/a.png"]);
  });

  it("resolves the session exactly once for a forwarded aliased route (CodeRabbit finding, PR #615)", async () => {
    const getSessionCalls = { count: 0 };
    const { env } = await makeEnv({ getSessionCalls });
    const res = await app.request(
      "/me/workspaces/acme/files/facets",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(200);
    // `me.ts`'s own `sessionAuth` middleware resolves the session once;
    // `dualWorkspaceAuth` must find the pre-resolved userId and skip its own
    // `get-session` fetch rather than resolving it again.
    expect(getSessionCalls.count).toBe(1);
  });

  it("a direct external request to the canonical path still authenticates via sessionAuth (WeakMap miss)", async () => {
    const getSessionCalls = { count: 0 };
    const { env, bucket } = await makeEnv({ getSessionCalls });
    await seed(bucket);
    const res = await app.request(
      "/v1/workspaces/acme/files",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(getSessionCalls.count).toBe(1);
  });

  it("membership rejection still applies to forwarded aliased calls (wrong workspace -> 404)", async () => {
    const { env } = await makeEnv({ member: false });
    const res = await app.request(
      "/me/workspaces/acme/files/facets",
      { headers: { cookie: "session=x" } },
      env,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("workspace_not_found");
  });
});

describe("ALL /v1/workspaces/:workspace/file-browser (session-only, member-gated, issue #613 final phase)", () => {
  it("member session reaches the files-sdk readonly list gateway", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket);
    const res = await app.request(
      "/v1/workspaces/acme/file-browser",
      {
        method: "POST",
        headers: { cookie: "session=x", "content-type": "application/json" },
        body: JSON.stringify({ op: "list" }),
      },
      env,
    );
    expect(res.status).toBe(200);
  });

  it("bearer 403s with file_browser_requires_session", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/workspaces/acme/file-browser",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ op: "list" }),
      },
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("file_browser_requires_session");
  });

  it("non-member session 404s", async () => {
    const { env } = await makeEnv({ member: false });
    const res = await app.request(
      "/v1/workspaces/acme/file-browser",
      {
        method: "POST",
        headers: { cookie: "session=x", "content-type": "application/json" },
        body: JSON.stringify({ op: "list" }),
      },
      env,
    );
    expect(res.status).toBe(404);
  });

  it("/me/workspaces/:name/file-browser forwards to the same handler (identical body)", async () => {
    const { env, bucket } = await makeEnv();
    await seed(bucket);
    const direct = await app.request(
      "/v1/workspaces/acme/file-browser",
      {
        method: "POST",
        headers: { cookie: "session=x", "content-type": "application/json" },
        body: JSON.stringify({ op: "list" }),
      },
      env,
    );
    const viaMe = await app.request(
      "/me/workspaces/acme/file-browser",
      {
        method: "POST",
        headers: { cookie: "session=x", "content-type": "application/json" },
        body: JSON.stringify({ op: "list" }),
      },
      env,
    );
    expect(viaMe.status).toBe(direct.status);
    expect(await viaMe.json()).toEqual(await direct.json());
  });
});
