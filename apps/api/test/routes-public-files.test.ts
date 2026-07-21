import { beforeAll, describe, expect, it } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import { FakeKv } from "./fake-kv";
import { FileMetadataTable } from "./helpers/fake-file-metadata-table";
import { app } from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";

// The public file page (issue #135) is served over HTTP from this endpoint:
// apps/web has no storage bindings, so it fetches metadata + a resolved URL
// from `GET /public/files/:workspace/:key`. The endpoint — not the Astro page —
// is the security surface: unauthenticated, single-key, no listing, and only
// for publicly-served (publicBaseUrl) workspaces in Phase 1.

const TOKEN = "secret-token";

/**
 * Fake D1 backing `file_metadata` with a real in-memory store (shared
 * `FileMetadataTable`, also used by routes-files.test.ts), so this suite can
 * assert on the `metadata`/`github` DTO fields the public endpoint derives
 * from real rows rather than a stubbed-empty read.
 */
function makeFakeDB() {
  const table = new FileMetadataTable();

  return {
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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function makeEnv(
  overrides: Partial<WorkspaceRecord> = {},
  opts: { db?: ReturnType<typeof makeFakeDB> } = {},
) {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "uploads-default",
    binding: "UPLOADS_DEFAULT",
    prefix: "default/",
    publicBaseUrl: "https://storage.uploads.sh",
    tokenHash: await sha256Hex(TOKEN),
    ...overrides,
  };
  const bucket = new FakeR2Bucket();
  const env = {
    REGISTRY: { get: async () => record, put: async () => undefined },
    // Defaults to a no-op D1 (existing tests don't assert on file_metadata rows,
    // just that putObject's D1 write doesn't blow up); pass `opts.db` to back
    // `file_metadata` with a real in-memory store for the metadata/github tests.
    DB: opts.db ?? {
      prepare: () => ({
        bind() {
          return this;
        },
        async first() {
          return null;
        },
        async run() {
          return { success: true, meta: { changes: 0 }, results: [] };
        },
        async all() {
          return { success: true, results: [], meta: {} };
        },
      }),
      async batch(stmts: { run: () => Promise<unknown> }[]) {
        return Promise.all(stmts.map((s) => s.run()));
      },
    },
    UPLOADS_DEFAULT: bucket,
    WRITE_LIMITER: { limit: async () => ({ success: true }) },
  };
  return { env, bucket };
}

/** PUT a nested key (so auto-prefix does not rewrite it), returning the stored key. */
async function seedShot(
  env: Parameters<typeof app.request>[2],
  headers: Record<string, string> = {},
) {
  const res = await app.request(
    "/v1/default/files/screenshots/shot.png",
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "image/png",
        // Strict-key overwrite gate (issue #174): several tests re-seed the
        // same key deliberately (uploaded-at stamping, metadata cascade) —
        // opt in so this fixture keeps its old always-overwrite behavior.
        "X-Uploads-Replace": "1",
        ...headers,
      },
      body: PNG,
    },
    env,
  );
  if (res.status !== 201) throw new Error(`seed failed: ${res.status}`);
  return "screenshots/shot.png";
}

describe("GET /public/files/:workspace/:key", () => {
  it("returns metadata + the public URL for a stored object without auth", async () => {
    const { env } = await makeEnv();
    await seedShot(env);

    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      workspace: string;
      key: string;
      url: string;
      size: number;
      contentType: string;
    };
    expect(json.workspace).toBe("default");
    expect(json.key).toBe("screenshots/shot.png");
    expect(json.url).toBe("https://storage.uploads.sh/default/screenshots/shot.png");
    expect(json.contentType).toBe("image/png");
    expect(json.size).toBeGreaterThan(0);
  });

  it("includes an embedUrl alongside the stable url", async () => {
    const { env } = await makeEnv();
    await seedShot(env);

    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { url: string; embedUrl: string | null };
    expect(json.url).toBe("https://storage.uploads.sh/default/screenshots/shot.png");
    expect(json.embedUrl).toBe("https://embed.uploads.sh/default/screenshots/shot.png");
  });

  it("never surfaces provenance metadata on the public surface", async () => {
    const { env } = await makeEnv();
    // The server always writes content-sha256 provenance itself; a client
    // spoof attempt now rejects the upload outright (file_metadata_reserved_key).
    await seedShot(env, { "X-Uploads-Meta-Client": "uploads-cli" });

    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).not.toHaveProperty("metadata");
  });

  it("404s for a missing object", async () => {
    const { env } = await makeEnv();
    const res = await app.request("/public/files/default/screenshots/missing.png", {}, env);
    expect(res.status).toBe(404);
  });

  it("404s when the workspace is not publicly served (no publicBaseUrl)", async () => {
    const { env } = await makeEnv({ publicBaseUrl: undefined });
    // Seeding still works (bucket write); only public resolution should refuse.
    await app.request(
      "/v1/default/files/screenshots/shot.png",
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "image/png" },
        body: PNG,
      },
      env,
    );
    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    expect(res.status).toBe(404);
  });

  it("404s on a traversal / bad key rather than resolving it", async () => {
    const { env } = await makeEnv();
    const res = await app.request("/public/files/default/../../etc/passwd", {}, env);
    expect(res.status).toBe(404);
  });

  it("exposes no listing/enumeration surface (workspace root has no route)", async () => {
    const { env } = await makeEnv();
    const res = await app.request("/public/files/default", {}, env);
    expect(res.status).toBe(404);
  });

  it("401s with auth_required for a private object, without leaking metadata", async () => {
    const { env } = await makeEnv();
    await seedShot(env, { "X-Uploads-Visibility": "private" });

    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("auth_required");
    expect(json).not.toHaveProperty("metadata");
    expect(json).not.toHaveProperty("visibility");
  });

  it("stays public when the upload header is anything other than 'private'", async () => {
    const { env } = await makeEnv();
    await seedShot(env, { "X-Uploads-Visibility": "public" });

    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    expect(res.status).toBe(200);
  });

  it("includes file_metadata and a derived github object when gh.* is valid", async () => {
    const { env } = await makeEnv({}, { db: makeFakeDB() });
    await seedShot(env, {
      "X-Uploads-Meta-gh.repo": "buildinternet/uploads",
      "X-Uploads-Meta-gh.kind": "pull",
      "X-Uploads-Meta-gh.number": "142",
      "X-Uploads-Meta-app": "uploads-cli",
    });

    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      metadata?: Record<string, string>;
      github?: { repo: string; kind: string; number: number; url: string };
    };
    expect(json.metadata).toEqual({
      "gh.repo": "buildinternet/uploads",
      "gh.kind": "pull",
      "gh.number": "142",
      app: "uploads-cli",
    });
    expect(json.github).toEqual({
      repo: "buildinternet/uploads",
      kind: "pull",
      number: 142,
      url: "https://github.com/buildinternet/uploads/pull/142",
    });
  });

  it("derives an issues URL for gh.kind = issue", async () => {
    const { env } = await makeEnv({}, { db: makeFakeDB() });
    await seedShot(env, {
      "X-Uploads-Meta-gh.repo": "buildinternet/uploads",
      "X-Uploads-Meta-gh.kind": "issue",
      "X-Uploads-Meta-gh.number": "7",
    });

    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    const json = (await res.json()) as { github?: { url: string } };
    expect(json.github?.url).toBe("https://github.com/buildinternet/uploads/issues/7");
  });

  it("omits both fields when the file has no metadata", async () => {
    const { env } = await makeEnv({}, { db: makeFakeDB() });
    await seedShot(env);

    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).not.toHaveProperty("metadata");
    expect(json).not.toHaveProperty("github");
  });

  it("omits github but keeps raw pairs when gh.* is malformed (non-numeric number)", async () => {
    const { env } = await makeEnv({}, { db: makeFakeDB() });
    await seedShot(env, {
      "X-Uploads-Meta-gh.repo": "buildinternet/uploads",
      "X-Uploads-Meta-gh.kind": "pull",
      "X-Uploads-Meta-gh.number": "not-a-number",
    });

    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    const json = (await res.json()) as {
      metadata?: Record<string, string>;
      github?: unknown;
    };
    expect(json.metadata).toEqual({
      "gh.repo": "buildinternet/uploads",
      "gh.kind": "pull",
      "gh.number": "not-a-number",
    });
    expect(json.github).toBeUndefined();
  });

  it("omits github when gh.kind is neither pull nor issue", async () => {
    const { env } = await makeEnv({}, { db: makeFakeDB() });
    await seedShot(env, {
      "X-Uploads-Meta-gh.repo": "buildinternet/uploads",
      "X-Uploads-Meta-gh.kind": "discussion",
      "X-Uploads-Meta-gh.number": "5",
    });

    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    const json = (await res.json()) as { metadata?: Record<string, string>; github?: unknown };
    expect(json.metadata).toBeDefined();
    expect(json.github).toBeUndefined();
  });

  it("omits github when a gh.* key is missing entirely", async () => {
    const { env } = await makeEnv({}, { db: makeFakeDB() });
    await seedShot(env, {
      "X-Uploads-Meta-gh.repo": "buildinternet/uploads",
      "X-Uploads-Meta-gh.number": "5",
    });

    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    const json = (await res.json()) as { metadata?: Record<string, string>; github?: unknown };
    expect(json.metadata).toEqual({ "gh.repo": "buildinternet/uploads", "gh.number": "5" });
    expect(json.github).toBeUndefined();
  });

  it("401s with auth_required for a private file and never fetches/leaks metadata", async () => {
    const { env } = await makeEnv({}, { db: makeFakeDB() });
    await seedShot(env, {
      "X-Uploads-Visibility": "private",
      "X-Uploads-Meta-gh.repo": "buildinternet/uploads",
      "X-Uploads-Meta-gh.kind": "pull",
      "X-Uploads-Meta-gh.number": "1",
    });

    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    expect(res.status).toBe(401);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).not.toHaveProperty("metadata");
    expect(json).not.toHaveProperty("github");
  });

  it("includes github.title from stamped gh.title when live resolve is unavailable", async () => {
    // No GITHUB_CACHE / App → resolveTitles throws or returns nulls; stamp still wins.
    const { env } = await makeEnv({}, { db: makeFakeDB() });
    await seedShot(env, {
      "X-Uploads-Meta-gh.repo": "buildinternet/uploads",
      "X-Uploads-Meta-gh.kind": "pull",
      "X-Uploads-Meta-gh.number": "142",
      "X-Uploads-Meta-gh.title": "Fix the login bug",
    });
    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { github?: { title?: string } };
    expect(json.github?.title).toBe("Fix the login bug");
  });

  it("prefers live-resolved title over stamped gh.title", async () => {
    const kv = new FakeKv();
    // Cache hit short-circuits before App config is required (no network).
    kv.store.set("ghref:buildinternet/uploads#142", {
      value: JSON.stringify({
        v: { title: "Live title from cache", state: "open", kind: "pull" },
      }),
    });
    const { env } = await makeEnv({}, { db: makeFakeDB() });
    (env as { GITHUB_CACHE?: FakeKv }).GITHUB_CACHE = kv;

    await seedShot(env, {
      "X-Uploads-Meta-gh.repo": "buildinternet/uploads",
      "X-Uploads-Meta-gh.kind": "pull",
      "X-Uploads-Meta-gh.number": "142",
      "X-Uploads-Meta-gh.title": "Stamped title",
    });

    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { github?: { title?: string } };
    expect(json.github?.title).toBe("Live title from cache");
  });

  it("omits github.title when neither stamp nor live resolve provides one", async () => {
    const { env } = await makeEnv({}, { db: makeFakeDB() });
    await seedShot(env, {
      "X-Uploads-Meta-gh.repo": "buildinternet/uploads",
      "X-Uploads-Meta-gh.kind": "pull",
      "X-Uploads-Meta-gh.number": "142",
    });
    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { github?: { title?: string } };
    expect(json.github).toBeDefined();
    expect(json.github).not.toHaveProperty("title");
  });

  it("keeps stamped title when live resolve exceeds the public budget", async () => {
    // Slow GITHUB_CACHE.get simulates a cold ladder that would otherwise
    // approach resolveTitles' ~8s GitHub abort and trip apps/web's 4s fetch.
    // Public route races resolve with ~1.4s and must return the stamp.
    const slowKv = {
      async get() {
        await new Promise((r) => setTimeout(r, 5000));
        return null;
      },
      async put() {
        /* no-op */
      },
    };
    const { env } = await makeEnv({}, { db: makeFakeDB() });
    (env as { GITHUB_CACHE?: typeof slowKv }).GITHUB_CACHE = slowKv;

    await seedShot(env, {
      "X-Uploads-Meta-gh.repo": "buildinternet/uploads",
      "X-Uploads-Meta-gh.kind": "pull",
      "X-Uploads-Meta-gh.number": "142",
      "X-Uploads-Meta-gh.title": "Stamped under budget",
    });

    const started = Date.now();
    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    const elapsedMs = Date.now() - started;
    expect(res.status).toBe(200);
    const json = (await res.json()) as { github?: { title?: string } };
    expect(json.github?.title).toBe("Stamped under budget");
    // Budget 1400ms + request overhead; must stay well under web's 4s abort.
    expect(elapsedMs).toBeLessThan(3000);
  });
});

// Task 3 (corrected): forced-download streaming lives behind a `?download=1`
// query flag on the SAME handler as the metadata route above, mirroring the
// `?metadata=1` convention already used by routes/files.ts (see the comment
// there). A sibling `/download` suffix route was rejected: a static suffix
// after the greedy `:key{.+}` param is inherently ambiguous — a request for
// `/public/files/default/screenshots/download` can never be distinguished
// from a request for the object whose key literally is
// `screenshots/download` (the #158 trap, reverse direction). The query param
// has no such shadowing, proven by the last test in this block.
describe("GET /public/files/:workspace/:key?download=1", () => {
  it("streams the object with a forced attachment disposition", async () => {
    const { env } = await makeEnv();
    await seedShot(env);

    const res = await app.request("/public/files/default/screenshots/shot.png?download=1", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"shot.png\"; filename*=UTF-8''shot.png",
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(PNG);
  });

  it("401s with auth_required for a private object, without streaming bytes", async () => {
    const { env } = await makeEnv();
    await seedShot(env, { "X-Uploads-Visibility": "private" });

    const res = await app.request("/public/files/default/screenshots/shot.png?download=1", {}, env);
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "auth_required" },
    });
  });

  it("404s for a missing object", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/public/files/default/screenshots/missing.png?download=1",
      {},
      env,
    );
    expect(res.status).toBe(404);
  });

  it("returns the unchanged JSON metadata response when the flag is absent (regression guard)", async () => {
    const { env } = await makeEnv();
    await seedShot(env);

    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBeNull();
    const json = (await res.json()) as { workspace: string; key: string; url: string };
    expect(json.workspace).toBe("default");
    expect(json.key).toBe("screenshots/shot.png");
    expect(json.url).toBe("https://storage.uploads.sh/default/screenshots/shot.png");
  });

  it("does not shadow a key that literally contains a 'download' segment", async () => {
    // Proof the query-param design has no ambiguity: a key ending in
    // "screenshots/download.png" is served correctly both ways.
    const { env } = await makeEnv();
    const put = await app.request(
      "/v1/default/files/screenshots/download.png",
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "image/png" },
        body: PNG,
      },
      env,
    );
    expect(put.status).toBe(201);

    const meta = await app.request("/public/files/default/screenshots/download.png", {}, env);
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { key: string }).key).toBe("screenshots/download.png");

    const download = await app.request(
      "/public/files/default/screenshots/download.png?download=1",
      {},
      env,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toBe(
      "attachment; filename=\"download.png\"; filename*=UTF-8''download.png",
    );
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(bytes).toEqual(PNG);
  });
});

describe("GET /public/files uploaded + modified dates", () => {
  it("returns uploaded from uploaded-at and omits modified when equal", async () => {
    const { env } = await makeEnv();
    await seedShot(env);
    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    const json = (await res.json()) as { uploaded?: string; modified?: string };
    expect(json.uploaded).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Fresh put: lastModified ≈ uploaded-at → modified omitted
    expect(json.modified).toBeUndefined();
  });

  it("includes modified when lastModified differs from uploaded-at", async () => {
    const { env, bucket } = await makeEnv();
    await seedShot(env);
    const entry = [...bucket.store.entries()].find(([k]) => k.endsWith("screenshots/shot.png"))!;
    // Keep uploaded-at, advance R2 mtime
    entry[1].customMetadata = {
      ...entry[1].customMetadata,
      "uploaded-at": "2026-01-01T00:00:00.000Z",
    };
    bucket.setUploaded(entry[0], new Date("2026-06-15T12:00:00.000Z"));

    const res = await app.request("/public/files/default/screenshots/shot.png", {}, env);
    const json = (await res.json()) as { uploaded?: string; modified?: string };
    expect(json.uploaded).toBe("2026-01-01T00:00:00.000Z");
    expect(json.modified).toBe("2026-06-15T12:00:00.000Z");
  });
});

// Task 1: first-upload stamp on putObject (Files SDK custom metadata).
// Public JSON dual-date mapping is Task 2 — these only assert R2 customMetadata.
describe("putObject uploaded-at stamp", () => {
  it("stamps uploaded-at on first put and preserves it across overwrite", async () => {
    const { env, bucket } = await makeEnv();
    await seedShot(env);

    const key = "default/screenshots/shot.png";
    const first = bucket.store.get(key);
    expect(first).toBeTruthy();
    const firstStamp = first!.customMetadata?.["uploaded-at"];
    expect(firstStamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Overwrite same key
    await seedShot(env);
    expect(bucket.store.get(key)?.customMetadata?.["uploaded-at"]).toBe(firstStamp);
  });

  it("seeds uploaded-at from prior lastModified when overwriting a legacy object", async () => {
    const { env, bucket } = await makeEnv();
    await seedShot(env);
    const key = "default/screenshots/shot.png";
    const obj = bucket.store.get(key)!;
    const priorLm = new Date("2026-01-15T10:00:00.000Z");
    // Strip stamp + backdate mtime to simulate pre-feature object
    obj.customMetadata = { ...obj.customMetadata };
    delete obj.customMetadata["uploaded-at"];
    bucket.setUploaded(key, priorLm);

    await seedShot(env);
    expect(bucket.store.get(key)?.customMetadata?.["uploaded-at"]).toBe(priorLm.toISOString());
  });
});
