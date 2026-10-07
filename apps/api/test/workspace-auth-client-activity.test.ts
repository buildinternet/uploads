/// <reference types="node" />

/**
 * `workspaceAuth` records the CLI's client version per credential
 * (`client_activity`) from its User-Agent, and records nothing for any other
 * caller.
 */

import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { respondError } from "../src/error-response";
import { sha256Hex, workspaceAuth, type WorkspaceVars } from "../src/workspace";
import { database, SqliteD1 } from "./helpers/sqlite-d1";

const TOKEN = "up_acme_secrettoken";
const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260712230000_token_minting_user.sql",
  "migrations/20260817180000_token_last_used.sql",
  "migrations/20260925120000_workspace_service_tokens.sql",
  "migrations/20261007120000_client_activity.sql",
];

beforeAll(() => {
  if (!(crypto.subtle as SubtleCrypto & { timingSafeEqual?: unknown }).timingSafeEqual) {
    Object.defineProperty(crypto.subtle, "timingSafeEqual", {
      value: (left: ArrayBufferView, right: ArrayBufferView) => {
        const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
        const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
        if (a.length !== b.length) return false;
        let difference = 0;
        for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
        return difference === 0;
      },
    });
  }
});

async function setup() {
  const sqlite = new SqliteD1(MIGRATIONS);
  sqlite.db
    .prepare(
      `INSERT INTO auth_tokens (id, workspace, token_hash, label, scopes, created_at, minting_user_id)
       VALUES ('tok-1', 'acme', ?, 'laptop', '["files:read"]', '2026-01-01', 'u1')`,
    )
    .run(await sha256Hex(TOKEN));
  const env = {
    REGISTRY: {
      get: async () => ({
        provider: "r2",
        bucket: "uploads-default",
        binding: "UPLOADS_DEFAULT",
        prefix: "acme/",
      }),
      put: async () => undefined,
    },
    DB: database(sqlite),
  } as unknown as Env;
  const app = new Hono<WorkspaceVars>()
    .use("/:workspace/*", workspaceAuth)
    .get("/:workspace/whoami", (c) => c.json({ ok: true }))
    .onError((err, c) => respondError(c, err));
  const call = (userAgent: string) =>
    app.request(
      "/acme/whoami",
      { headers: { Authorization: `Bearer ${TOKEN}`, "User-Agent": userAgent } },
      env,
    );
  const rows = () =>
    sqlite.db
      .prepare("SELECT principal, surface, user_id, client_version FROM client_activity")
      .all();
  return { sqlite, call, rows };
}

describe("workspaceAuth client activity", () => {
  it("records the CLI version against the D1 token", async () => {
    const { sqlite, call, rows } = await setup();
    try {
      expect((await call("@buildinternet/uploads/1.4.2 (cli)")).status).toBe(200);
      expect((await call("@buildinternet/uploads/1.4.2 (mcp)")).status).toBe(200);
      expect(rows()).toEqual([
        { principal: "token:tok-1", surface: "cli", user_id: "u1", client_version: "1.4.2" },
        { principal: "token:tok-1", surface: "mcp-local", user_id: "u1", client_version: "1.4.2" },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("records nothing for a non-CLI User-Agent", async () => {
    const { sqlite, call, rows } = await setup();
    try {
      expect((await call("curl/8.4.0")).status).toBe(200);
      expect(rows()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
