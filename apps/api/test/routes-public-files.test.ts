import { beforeAll, describe, expect, it } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import { app } from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";

// The public file page (issue #135) is served over HTTP from this endpoint:
// apps/web has no storage bindings, so it fetches metadata + a resolved URL
// from `GET /public/files/:workspace/:key`. The endpoint — not the Astro page —
// is the security surface: unauthenticated, single-key, no listing, and only
// for publicly-served (publicBaseUrl) workspaces in Phase 1.

const TOKEN = "secret-token";

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

async function makeEnv(overrides: Partial<WorkspaceRecord> = {}) {
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
    DB: {
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
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "image/png", ...headers },
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

  it("never surfaces provenance metadata on the public surface", async () => {
    const { env } = await makeEnv();
    await seedShot(env, {
      "X-Uploads-Meta-Client": "uploads-cli",
      "X-Uploads-Meta-Content-Sha256": "0".repeat(64),
    });

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
});
