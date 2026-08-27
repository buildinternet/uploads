/**
 * POST /admin/enrollments with an `email` recipient (issue #754 item 3):
 * EMAIL is an optional binding, and the invite-email send is wrapped in its
 * own try/catch (see admin.ts) so a missing/failing binding degrades to
 * `emailed: false` on an otherwise-successful 201, never a 500 — the
 * enrollment record itself is always created regardless of mail delivery.
 */
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { SqliteD1, database } from "../../test/helpers/sqlite-d1";
import { respondError } from "../error-response";
import { admin } from "./admin";

const ADMIN_TOKEN = "test-admin-token";
const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260711120000_invite_pages.sql",
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

function appWith(email?: { send: (message: unknown) => Promise<unknown> }) {
  const app = new Hono<{ Bindings: Env }>()
    .route("/admin", admin)
    .onError((err, c) => respondError(c, err));
  const store = new Map<string, unknown>(Object.entries({ "ws:acme": RECORD }));
  const env = {
    ADMIN_TOKEN,
    REGISTRY: {
      get: (async (key: string) => store.get(key) ?? null) as unknown as KVNamespace["get"],
    },
    DB: database(new SqliteD1(MIGRATIONS)),
    EMAIL: email,
  } as unknown as Env;
  return { app, env };
}

function post(app: Hono<{ Bindings: Env }>, env: Env, body: unknown) {
  return app.request(
    "/admin/enrollments",
    {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("POST /admin/enrollments — EMAIL binding absent", () => {
  it("creates the enrollment and reports emailed: false without throwing", async () => {
    const { app, env } = appWith(undefined);
    const res = await post(app, env, {
      workspace: "acme",
      label: "ci",
      scopes: ["files:read"],
      email: "person@example.com",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { emailed?: boolean; code?: string };
    expect(body.emailed).toBe(false);
    expect(typeof body.code).toBe("string");
  });

  it("reports emailed: true when EMAIL is present", async () => {
    const send = async () => ({});
    const { app, env } = appWith({ send });
    const res = await post(app, env, {
      workspace: "acme",
      label: "ci",
      scopes: ["files:read"],
      email: "person@example.com",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { emailed?: boolean };
    expect(body.emailed).toBe(true);
  });

  it("omits emailed entirely (undefined) when no recipient was requested", async () => {
    const { app, env } = appWith(undefined);
    const res = await post(app, env, { workspace: "acme", label: "ci", scopes: ["files:read"] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { emailed?: boolean };
    expect(body.emailed).toBeUndefined();
  });
});
