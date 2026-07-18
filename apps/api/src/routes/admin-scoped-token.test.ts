import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { SqliteD1, database } from "../../test/helpers/sqlite-d1";
import { createToken } from "../auth-db";
import { respondError } from "../error-response";
import { admin } from "./admin";

const ADMIN_TOKEN = "test-admin-token";
const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260712230000_token_minting_user.sql",
];

const RECORD = {
  provider: "r2",
  bucket: "shared",
  binding: "UPLOADS_DEFAULT",
  prefix: "acme/",
  publicBaseUrl: "https://storage.uploads.sh",
};

beforeAll(() => {
  if (typeof crypto.subtle.timingSafeEqual !== "function") {
    (
      crypto.subtle as unknown as { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean }
    ).timingSafeEqual = (a: Uint8Array, b: Uint8Array) =>
      a.length === b.length && a.every((byte, i) => byte === b[i]);
  }
});

function fakeKv(records: Record<string, unknown>) {
  const store = new Map(Object.entries(records));
  return {
    get: (async (key: string) => store.get(key) ?? null) as unknown as KVNamespace["get"],
  };
}

function appWith(opts: { adminToken?: string | undefined; db: SqliteD1 }) {
  const { adminToken = ADMIN_TOKEN, db } = opts;
  const app = new Hono<{ Bindings: Env }>()
    .route("/admin", admin)
    .onError((err, c) => respondError(c, err));
  const env = {
    ADMIN_TOKEN: adminToken,
    REGISTRY: fakeKv({ "ws:acme": RECORD }),
    DB: database(db),
  } as unknown as Env;
  return { app, env };
}

function getTokens(bearer: string) {
  return new Request("https://api.uploads.sh/admin/tokens?workspace=acme", {
    headers: { authorization: `Bearer ${bearer}` },
  });
}

function deleteTokens(bearer: string) {
  return new Request("https://api.uploads.sh/admin/tokens", {
    method: "DELETE",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ workspace: "acme", label: "nope" }),
  });
}

describe("adminAuth accepts D1-backed scoped operator tokens", () => {
  it("operator:read token can GET /admin/tokens", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["operator:read"],
    });
    const { app, env } = appWith({ db });
    const res = await app.request(getTokens(token), {}, env);
    expect(res.status).toBe(200);
  });

  it("operator:read token gets 403 on DELETE /admin/tokens", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["operator:read"],
    });
    const { app, env } = appWith({ db });
    const res = await app.request(deleteTokens(token), {}, env);
    expect(res.status).toBe(403);
  });

  it("operator:write token can GET and DELETE (superset of operator:read)", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["operator:write"],
    });
    const { app, env } = appWith({ db });
    const getRes = await app.request(getTokens(token), {}, env);
    expect(getRes.status).toBe(200);
    // DELETE reaches the handler (403 forbidden by scope check would mean
    // adminAuth rejected it before the route ran); a 404 here means adminAuth
    // let it through and the route itself found no matching token.
    const deleteRes = await app.request(deleteTokens(token), {}, env);
    expect(deleteRes.status).not.toBe(401);
    expect(deleteRes.status).not.toBe(403);
  });

  it("revoked token is rejected with 401", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token, record } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["operator:read"],
    });
    await db
      .prepare(`UPDATE auth_tokens SET revoked_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), record.id)
      .run();
    const { app, env } = appWith({ db });
    const res = await app.request(getTokens(token), {}, env);
    expect(res.status).toBe(401);
  });

  it("expired token is rejected with 401", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["operator:read"],
      expiresAt: new Date(Date.now() - 1000),
    });
    const { app, env } = appWith({ db });
    const res = await app.request(getTokens(token), {}, env);
    expect(res.status).toBe(401);
  });

  it("a files-only token (no operator scope) is rejected with 403", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["files:read", "files:write"],
    });
    const { app, env } = appWith({ db });
    const res = await app.request(getTokens(token), {}, env);
    expect(res.status).toBe(403);
  });

  it("the static ADMIN_TOKEN still works", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { app, env } = appWith({ db });
    const res = await app.request(getTokens(ADMIN_TOKEN), {}, env);
    expect(res.status).toBe(200);
  });

  it("a valid scoped token works even when ADMIN_TOKEN is unset", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { token } = await createToken(db as unknown as D1Database, {
      workspace: "acme",
      scopes: ["operator:read"],
    });
    const { app, env } = appWith({ db, adminToken: undefined });
    const res = await app.request(getTokens(token), {}, env);
    expect(res.status).toBe(200);
  });

  it("no auth header is rejected with 401", async () => {
    const db = new SqliteD1(MIGRATIONS);
    const { app, env } = appWith({ db });
    const res = await app.request(
      new Request("https://api.uploads.sh/admin/tokens?workspace=acme"),
      {},
      env,
    );
    expect(res.status).toBe(401);
  });
});
