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
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { FakeR2Bucket } from "./fake-r2";
import { FileMetadataTable } from "./helpers/fake-file-metadata-table";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";

const TOKEN = "canonical-secret-token";
const USER = { id: "u-1", email: "member@example.com", name: "Member" };

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
  opts: { member?: boolean; session?: boolean; getSessionCalls?: { count: number } } = {},
): Promise<{ env: Parameters<typeof app.request>[2]; bucket: FakeR2Bucket }> {
  const { member = true, session = true, getSessionCalls } = opts;
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "uploads-default",
    binding: "UPLOADS_DEFAULT",
    prefix: "acme/",
    publicBaseUrl: "https://storage.uploads.sh",
    tokenHash: await sha256Hex(TOKEN),
  };
  const bucket = new FakeR2Bucket();
  const db = makeFakeDB();
  const env = {
    REGISTRY: {
      get: async (key: string) => (key === "ws:acme" ? record : null),
    },
    UPLOADS_DEFAULT: bucket,
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
