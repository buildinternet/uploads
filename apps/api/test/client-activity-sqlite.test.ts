/// <reference types="node" />

/**
 * Client-activity tracking: User-Agent / MCP clientInfo parsing, the
 * throttled upsert, and the admin listing's token + user joins, against real
 * SQL.
 */

import { describe, expect, it } from "vitest";
import {
  CLIENT_ACTIVITY_TOUCH_SECONDS,
  clientActivityResponse,
  listClientActivity,
  parseCliUserAgent,
  parseMcpClientInfo,
  principalFromAuth,
  recordClientActivity,
  type ClientActivityInput,
} from "../src/client-activity";
import { database, SqliteD1 } from "./helpers/sqlite-d1";

const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260712230000_token_minting_user.sql",
  "migrations/20260817180000_token_last_used.sql",
  "migrations/20260925120000_workspace_service_tokens.sql",
  "migrations/20260822120000_auth_tables.sql",
  "migrations/20261007120000_client_activity.sql",
];

function setup() {
  const sqlite = new SqliteD1(MIGRATIONS);
  return { sqlite, db: database(sqlite) };
}

const T0 = new Date("2026-10-07T12:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function cliInput(overrides: Partial<ClientActivityInput> = {}): ClientActivityInput {
  return {
    workspace: "acme",
    principal: "token:tok-1",
    tokenId: "tok-1",
    userId: null,
    surface: "cli",
    clientName: "@buildinternet/uploads",
    clientVersion: "1.2.0",
    ...overrides,
  };
}

async function rows(sqlite: SqliteD1) {
  return sqlite.db.prepare("SELECT * FROM client_activity ORDER BY surface").all() as Record<
    string,
    unknown
  >[];
}

describe("parseCliUserAgent", () => {
  it("reads the version and surface from the CLI's User-Agent", () => {
    expect(parseCliUserAgent("@buildinternet/uploads/1.4.2 (cli)")).toEqual({
      surface: "cli",
      clientName: "@buildinternet/uploads",
      clientVersion: "1.4.2",
    });
    expect(parseCliUserAgent("@buildinternet/uploads/1.4.2 (mcp)")?.surface).toBe("mcp-local");
    expect(parseCliUserAgent("@buildinternet/uploads/2.0.0-beta.1")?.clientVersion).toBe(
      "2.0.0-beta.1",
    );
  });

  it("ignores every other User-Agent", () => {
    expect(parseCliUserAgent(undefined)).toBeNull();
    expect(parseCliUserAgent("node")).toBeNull();
    expect(parseCliUserAgent("Mozilla/5.0 @buildinternet/uploads/1.0.0")).toBeNull();
    expect(parseCliUserAgent("uploads-cli/1.0.0")).toBeNull();
  });
});

describe("parseMcpClientInfo", () => {
  it("reads clientInfo from a 2025-era initialize", () => {
    expect(
      parseMcpClientInfo({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "claude-code", version: "2.1.0" } },
      }),
    ).toEqual({ surface: "mcp-remote", clientName: "claude-code", clientVersion: "2.1.0" });
  });

  it("prefers the per-request _meta clientInfo", () => {
    expect(
      parseMcpClientInfo({
        method: "tools/call",
        params: {
          name: "put",
          _meta: { "io.modelcontextprotocol/clientInfo": { name: "cursor", version: "1.0" } },
        },
      }),
    ).toEqual({ surface: "mcp-remote", clientName: "cursor", clientVersion: "1.0" });
  });

  it("rejects bodies without a usable name", () => {
    expect(parseMcpClientInfo(null)).toBeNull();
    expect(parseMcpClientInfo([{ method: "initialize" }])).toBeNull();
    expect(parseMcpClientInfo({ method: "tools/list", params: {} })).toBeNull();
    expect(parseMcpClientInfo({ params: { clientInfo: { name: "\u0000 " } } })).toBeNull();
  });
});

describe("principalFromAuth", () => {
  it("maps each auth lane to a row identity", () => {
    expect(principalFromAuth("d1-token:abc", "u1")).toEqual({
      principal: "token:abc",
      tokenId: "abc",
      userId: "u1",
    });
    expect(principalFromAuth(`legacy-token:${"f".repeat(64)}`, null)).toEqual({
      principal: "legacy:ffffffff",
      tokenId: null,
      userId: null,
    });
    expect(principalFromAuth("oauth-user:u2", null)).toEqual({
      principal: "user:u2",
      tokenId: null,
      userId: "u2",
    });
    expect(principalFromAuth(undefined, null)).toBeNull();
    expect(principalFromAuth("something-else:x", null)).toBeNull();
  });
});

describe("recordClientActivity", () => {
  it("inserts once, then skips unchanged writes inside the touch window", async () => {
    const { sqlite, db } = setup();
    try {
      await recordClientActivity(db, cliInput(), T0);
      await recordClientActivity(db, cliInput(), at(60));
      const [row] = await rows(sqlite);
      expect(row).toMatchObject({
        client_version: "1.2.0",
        first_seen_at: T0.toISOString(),
        last_seen_at: T0.toISOString(),
      });
    } finally {
      sqlite.close();
    }
  });

  it("refreshes last_seen_at once the window passes", async () => {
    const { sqlite, db } = setup();
    try {
      await recordClientActivity(db, cliInput(), T0);
      const later = at(CLIENT_ACTIVITY_TOUCH_SECONDS + 1);
      await recordClientActivity(db, cliInput(), later);
      const [row] = await rows(sqlite);
      expect(row).toMatchObject({
        first_seen_at: T0.toISOString(),
        last_seen_at: later.toISOString(),
      });
    } finally {
      sqlite.close();
    }
  });

  it("records an upgrade immediately", async () => {
    const { sqlite, db } = setup();
    try {
      await recordClientActivity(db, cliInput(), T0);
      await recordClientActivity(db, cliInput({ clientVersion: "1.3.0" }), at(5));
      const [row] = await rows(sqlite);
      expect(row).toMatchObject({ client_version: "1.3.0", last_seen_at: at(5).toISOString() });
    } finally {
      sqlite.close();
    }
  });

  it("keeps one row per surface for the same credential", async () => {
    const { sqlite, db } = setup();
    try {
      await recordClientActivity(db, cliInput(), T0);
      await recordClientActivity(db, cliInput({ surface: "mcp-local" }), T0);
      expect((await rows(sqlite)).map((r) => r.surface)).toEqual(["cli", "mcp-local"]);
    } finally {
      sqlite.close();
    }
  });
});

describe("listClientActivity", () => {
  it("joins the token label and the minting user's email, newest first", async () => {
    const { sqlite, db } = setup();
    try {
      sqlite.db.exec(`
        INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
          VALUES ('u1', 'Ada', 'ada@example.com', 1, 0, 0);
        INSERT INTO auth_tokens (id, workspace, token_hash, label, scopes, created_at, minting_user_id, owner)
          VALUES ('tok-1', 'acme', 'h1', 'laptop', '[]', '2026-01-01', 'u1', 'member'),
                 ('tok-2', 'acme', 'h2', 'ci-bot', '[]', '2026-01-01', NULL, 'workspace');
      `);
      await recordClientActivity(db, cliInput(), T0);
      await recordClientActivity(
        db,
        cliInput({ principal: "token:tok-2", tokenId: "tok-2", clientVersion: "1.0.0" }),
        at(10),
      );
      await recordClientActivity(
        db,
        cliInput({ workspace: "other", principal: "token:tok-9", tokenId: "tok-9" }),
        at(20),
      );

      const listed = (await listClientActivity(db, { workspace: "acme" })).map(
        clientActivityResponse,
      );
      expect(listed).toMatchObject([
        { principal: "token:tok-2", tokenLabel: "ci-bot", serviceToken: true, email: null },
        {
          principal: "token:tok-1",
          tokenLabel: "laptop",
          serviceToken: false,
          userId: "u1",
          email: "ada@example.com",
        },
      ]);
      expect(await listClientActivity(db)).toHaveLength(3);
      expect(await listClientActivity(db, { sinceDays: 1, now: at(2 * 86_400) })).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });
});
