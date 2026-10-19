import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { database, SqliteD1 } from "../test/helpers/sqlite-d1";
import {
  cliUpgradeRecipients,
  compareCliVersions,
  runCliUpgradeCampaign,
} from "./cli-upgrade-campaign";

const MIGRATIONS = [
  "migrations/20260822120000_auth_tables.sql",
  "migrations/20261007120000_client_activity.sql",
  "migrations/20261019170000_product_updates.sql",
];
const NOW = new Date("2026-10-19T12:00:00.000Z");
const RECENT = "2026-10-18T12:00:00.000Z";
const STALE = "2026-08-01T12:00:00.000Z";

let sqlite: SqliteD1;

function addUser(id: string) {
  sqlite.db
    .prepare("INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, 0, 0)")
    .run(id, id, `${id}@example.com`);
}

function seen(userId: string | null, version: string | null, at = RECENT, surface = "cli") {
  sqlite.db
    .prepare(
      `INSERT INTO client_activity
         (workspace, principal, surface, user_id, client_name, client_version, first_seen_at, last_seen_at)
       VALUES ('acme', ?, ?, ?, '@buildinternet/uploads', ?, ?, ?)`,
    )
    .run(`p-${Math.random()}`, surface, userId, version, at, at);
}

beforeEach(() => {
  sqlite = new SqliteD1(MIGRATIONS);
  for (const id of ["old", "current", "mixed", "ancient", "stale", "optout"]) addUser(id);
  seen("old", "0.58.2");
  seen("current", "0.60.0");
  seen("mixed", "0.55.0");
  seen("mixed", "0.59.1", RECENT, "mcp-local");
  seen("ancient", null);
  seen("stale", "0.50.0", STALE);
  seen("optout", "0.58.0");
  seen(null, "0.40.0");
  sqlite.db.prepare("UPDATE user SET notify_product_updates = 0 WHERE id = 'optout'").run();
});

afterEach(() => {
  sqlite.close();
});

describe("compareCliVersions", () => {
  it("orders by number, with a missing version lowest", () => {
    expect(compareCliVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareCliVersions("0.59.0-beta.1", "0.59.0")).toBe(0);
    expect(compareCliVersions(null, "0.1.0")).toBe(-1);
  });
});

describe("cliUpgradeRecipients", () => {
  it("picks opted-in people whose newest recent CLI is below the minimum", async () => {
    const got = await cliUpgradeRecipients(database(sqlite), "0.59.0", NOW);
    expect(got).toEqual([
      { userId: "ancient", email: "ancient@example.com", version: null },
      { userId: "old", email: "old@example.com", version: "0.58.2" },
    ]);
  });
});

describe("runCliUpgradeCampaign", () => {
  function env(sent: { messages: { userId: string }[] }[]) {
    return {
      DB: database(sqlite),
      AUTH: {
        fetch: async (_url: string, init: RequestInit) => {
          const body = JSON.parse(String(init.body)) as { messages: { userId: string }[] };
          sent.push(body);
          return Response.json({ sent: body.messages.map((m) => m.userId), failed: [] });
        },
      },
    } as unknown as Env;
  }

  it("only counts until asked to send", async () => {
    const calls: { messages: { userId: string }[] }[] = [];
    const result = await runCliUpgradeCampaign(env(calls), { minimumVersion: "0.59.0" }, NOW);
    expect(result).toMatchObject({ campaign: "cli-upgrade:0.59.0", eligible: 2 });
    expect(result.sent).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("sends once per person per campaign", async () => {
    const calls: { messages: { userId: string }[] }[] = [];
    const first = await runCliUpgradeCampaign(
      env(calls),
      { minimumVersion: "0.59.0", send: true },
      NOW,
    );
    expect(first).toMatchObject({ sent: 2, failed: 0, eligible: 0 });
    expect(calls[0]!.messages[0]).toEqual({
      userId: "ancient",
      to: "ancient@example.com",
      currentVersion: null,
      minimumVersion: "0.59.0",
    });
    const again = await runCliUpgradeCampaign(env(calls), { minimumVersion: "0.59.0" }, NOW);
    expect(again.eligible).toBe(0);
    // A new minimum is a new campaign.
    const next = await runCliUpgradeCampaign(env(calls), { minimumVersion: "0.61.0" }, NOW);
    expect(next.eligible).toBe(4);
  });

  it("rejects a malformed version", async () => {
    await expect(runCliUpgradeCampaign(env([]), { minimumVersion: "latest" }, NOW)).rejects.toThrow(
      /minimumVersion/,
    );
  });
});
