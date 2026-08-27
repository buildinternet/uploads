/**
 * The four `/admin` token/enrollment routes used to default an omitted
 * `workspace` to the communal `default` workspace. That made the shared tenant
 * the silent target of credential issuance: an operator minting a token or an
 * enrollment code "for a customer" and forgetting the field handed out
 * files:read/files:write on `default` instead — and because enrollment
 * redemption mints a token without creating an org membership
 * (`redeemEnrollment` in auth-db.ts), the recipient would not appear in any
 * member list while still reading and writing that workspace's objects.
 *
 * Requiring the field turns that silent mis-target into a 400. These tests pin
 * the rule per route so the default cannot be reintroduced one handler at a
 * time.
 */
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { SqliteD1, database } from "../../test/helpers/sqlite-d1";
import { respondError } from "../error-response";
import { admin } from "./admin";

const ADMIN_TOKEN = "test-admin-token";
const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260712230000_token_minting_user.sql",
  "migrations/20260817180000_token_last_used.sql",
  "migrations/20260827160000_auth_enrollments_kind.sql",
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

function appWith(db: SqliteD1) {
  const app = new Hono<{ Bindings: Env }>()
    .route("/admin", admin)
    .onError((err, c) => respondError(c, err));
  const store = new Map<string, unknown>(
    Object.entries({ "ws:acme": RECORD, "ws:default": { ...RECORD, prefix: "default/" } }),
  );
  const env = {
    ADMIN_TOKEN,
    REGISTRY: {
      get: (async (key: string) => store.get(key) ?? null) as unknown as KVNamespace["get"],
    },
    DB: database(db),
  } as unknown as Env;
  return { app, env };
}

function post(path: string, body: unknown) {
  return new Request(`https://api.uploads.sh${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The four routes, each exercised with `workspace` absent. */
const OMITTED: { name: string; request: () => Request }[] = [
  {
    name: "POST /admin/tokens",
    request: () => post("/admin/tokens", { label: "ci", scopes: ["files:read"] }),
  },
  {
    name: "POST /admin/enrollments",
    request: () => post("/admin/enrollments", { label: "ci", scopes: ["files:read"] }),
  },
  {
    name: "GET /admin/tokens",
    request: () =>
      new Request("https://api.uploads.sh/admin/tokens", {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
  },
  {
    name: "DELETE /admin/tokens",
    request: () =>
      new Request("https://api.uploads.sh/admin/tokens", {
        method: "DELETE",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ label: "ci" }),
      }),
  },
];

describe("admin routes require an explicit workspace", () => {
  for (const route of OMITTED) {
    it(`${route.name} rejects an omitted workspace with 400 workspace_required`, async () => {
      const { app, env } = appWith(new SqliteD1(MIGRATIONS));
      const res = await app.request(route.request(), {}, env);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("workspace_required");
    });

    it(`${route.name} rejects a blank workspace with 400 workspace_required`, async () => {
      const { app, env } = appWith(new SqliteD1(MIGRATIONS));
      const original = route.request();
      const url = new URL(original.url);
      const blanked =
        original.method === "GET"
          ? new Request(`${url.origin}${url.pathname}?workspace=%20%20`, {
              headers: original.headers,
            })
          : new Request(original.url, {
              method: original.method,
              headers: original.headers,
              body: JSON.stringify({
                ...(JSON.parse(await original.text()) as Record<string, unknown>),
                workspace: "   ",
              }),
            });
      const res = await app.request(blanked, {}, env);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("workspace_required");
    });
  }

  it("a malformed workspace stays invalid_workspace, distinct from omission", async () => {
    const { app, env } = appWith(new SqliteD1(MIGRATIONS));
    const res = await app.request(
      post("/admin/tokens", { workspace: "Not A Slug", label: "ci", scopes: ["files:read"] }),
      {},
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("invalid_workspace");
  });

  it("an explicit workspace still works — the gate is on omission, not on the value", async () => {
    const { app, env } = appWith(new SqliteD1(MIGRATIONS));
    const res = await app.request(
      post("/admin/tokens", { workspace: "acme", label: "ci", scopes: ["files:read"] }),
      {},
      env,
    );
    expect(res.status).toBe(201);
  });

  it("naming the communal workspace explicitly is still allowed", async () => {
    const { app, env } = appWith(new SqliteD1(MIGRATIONS));
    const res = await app.request(
      post("/admin/tokens", { workspace: "default", label: "ci", scopes: ["files:read"] }),
      {},
      env,
    );
    expect(res.status).toBe(201);
  });
});
