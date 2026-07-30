import { describe, expect, it } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import { DeleteUsageClaimsTable } from "./helpers/fake-delete-usage-claims-table";
import { FileMetadataTable } from "./helpers/fake-file-metadata-table";
import { app } from "../src/index";

const USER = { id: "user-1", email: "z@example.com", name: "Z" };

function makeFakeDB() {
  const table = new FileMetadataTable();
  const deleteClaims = new DeleteUsageClaimsTable();
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
            table.tryRun(normalized, args) ??
            deleteClaims.tryRun(normalized, args) ?? {
              success: true,
              meta: { changes: 0 },
              results: [],
            }
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

function makeEnv(opts: { session?: boolean; member?: boolean; rateLimitOk?: boolean } = {}) {
  const { session = true, member = true, rateLimitOk = true } = opts;
  const bucket = new FakeR2Bucket();
  const record = {
    provider: "r2",
    bucket: "uploads-default",
    binding: "UPLOADS_DEFAULT",
    prefix: "acme/",
    publicBaseUrl: "https://storage.uploads.sh",
  };
  const db = makeFakeDB();
  const env = {
    REGISTRY: {
      // loadWorkspaceRecord reads `ws:<name>` with { type: "json" }
      get: async (key: string) => (key === "ws:acme" ? record : null),
    },
    UPLOADS_DEFAULT: bucket,
    DB: db,
    WRITE_LIMITER: { limit: async () => ({ success: rateLimitOk }) },
    AUTH: {
      fetch: async (url: string) => {
        if (url.includes("/api/auth/get-session")) {
          if (!session) return Response.json(null);
          return Response.json({ session: {}, user: USER });
        }
        if (url.includes("/internal/memberships")) {
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
        return new Response("unexpected", { status: 500 });
      },
    },
  } as unknown as Parameters<typeof app.request>[2];
  return { env, bucket, db };
}

async function seed(bucket: FakeR2Bucket) {
  await bucket.put("acme/shots/a.png", new Uint8Array([1, 2, 3]).buffer, {
    httpMetadata: { contentType: "image/png" },
  });
}

function del(env: Parameters<typeof app.request>[2], key = "shots/a.png", workspace = "acme") {
  return app.request(
    `/me/workspaces/${workspace}/files?key=${encodeURIComponent(key)}`,
    { method: "DELETE" },
    env,
  );
}

describe("DELETE /me/workspaces/:name/files", () => {
  it("deletes the object and its metadata for a member", async () => {
    const { env, bucket, db } = makeEnv();
    await seed(bucket);
    db.metadata.set("acme shots/a.png", new Map([["gh.pr", "42"]]));

    const response = await del(env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ key: "shots/a.png", deleted: true });
    expect(await bucket.head("acme/shots/a.png")).toBeNull();
    expect(db.metadata.has("acme shots/a.png")).toBe(false);
  });

  it("404s for a signed-in non-member (uniform workspace_not_found)", async () => {
    const { env, bucket } = makeEnv({ member: false });
    await seed(bucket);
    const response = await del(env);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("workspace_not_found");
    expect(await bucket.head("acme/shots/a.png")).not.toBeNull();
  });

  it("401s when signed out", async () => {
    const { env } = makeEnv({ session: false });
    const response = await del(env);
    expect(response.status).toBe(401);
  });

  it("404s on an invalid key", async () => {
    const { env } = makeEnv();
    const response = await del(env, "../escape");
    expect(response.status).toBe(404);
  });

  it("429s when the write limiter says no — after the membership gate", async () => {
    const { env, bucket } = makeEnv({ rateLimitOk: false });
    await seed(bucket);
    const response = await del(env);
    expect(response.status).toBe(429);
    expect(await bucket.head("acme/shots/a.png")).not.toBeNull();
  });
});
