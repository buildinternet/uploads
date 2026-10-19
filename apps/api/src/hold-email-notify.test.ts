import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { database, SqliteD1 } from "../test/helpers/sqlite-d1";
import { emailHold, emailHoldRecipients } from "./hold-email-notify";

const MIGRATIONS = [
  "migrations/20260822120000_auth_tables.sql",
  "migrations/20261019130000_user_notify_email_holds.sql",
];

let sqlite: SqliteD1;

beforeEach(() => {
  sqlite = new SqliteD1(MIGRATIONS);
  const db = sqlite.db;
  db.prepare(
    "INSERT INTO organization (id, name, slug, created_at) VALUES ('o1', 'Acme', 'acme', 0)",
  ).run();
  for (const [id, role] of [
    ["u-owner", "owner"],
    ["u-admin", "admin"],
    ["u-member", "member"],
  ] as const) {
    db.prepare(
      "INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, 0, 0)",
    ).run(id, id, `${id}@example.com`);
    db.prepare(
      "INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (?, 'o1', ?, ?, 0)",
    ).run(`m-${id}`, id, role);
  }
});

afterEach(() => {
  sqlite.close();
});

function optIn(userId: string) {
  sqlite.db.prepare("UPDATE user SET notify_email_holds = 1 WHERE id = ?").run(userId);
}

describe("emailHoldRecipients", () => {
  it("is empty until someone opts in", async () => {
    expect(await emailHoldRecipients(database(sqlite), "acme", undefined)).toEqual([]);
    expect(await emailHoldRecipients(database(sqlite), "acme", "u-member")).toEqual([]);
  });

  it("emails only an opted-in member uploader", async () => {
    optIn("u-member");
    optIn("u-owner");
    expect(await emailHoldRecipients(database(sqlite), "acme", "u-member")).toEqual([
      { userId: "u-member", email: "u-member@example.com" },
    ]);
  });

  it("falls back to opted-in admins and owners, and skips banned users", async () => {
    optIn("u-owner");
    optIn("u-admin");
    optIn("u-member");
    let got = await emailHoldRecipients(database(sqlite), "acme", undefined);
    expect(got.map((r) => r.userId).sort()).toEqual(["u-admin", "u-owner"]);
    sqlite.db.prepare("UPDATE user SET banned = 1 WHERE id = 'u-owner'").run();
    got = await emailHoldRecipients(database(sqlite), "acme", undefined);
    expect(got.map((r) => r.userId)).toEqual(["u-admin"]);
  });
});

describe("emailHold", () => {
  it("sends one email per recipient with the file page link", async () => {
    optIn("u-member");
    const sent: { to: string; subject: string; text?: string }[] = [];
    const env = {
      DB: database(sqlite),
      WEB_ORIGIN: "https://uploads.sh",
      EMAIL: { send: async (message: (typeof sent)[number]) => void sent.push(message) },
    } as unknown as Env;
    const count = await emailHold(env, "acme", "shots/a b.png", "secret", {
      "gh.uploader-id": "u-member",
    });
    expect(count).toBe(1);
    expect(sent[0]!.to).toBe("u-member@example.com");
    expect(sent[0]!.subject).toBe("Held for review: a b.png");
    expect(sent[0]!.text).toContain("https://uploads.sh/f/acme/shots/a%20b.png");
    expect(sent[0]!.text).toContain("Your upload a b.png in acme is held for review.");
  });

  it("is a no-op without the binding and never throws", async () => {
    expect(await emailHold({} as Env, "acme", "k.png", "pii", {})).toBe(0);
    const broken = {
      DB: database(sqlite),
      EMAIL: {
        send: async () => {
          throw new Error("down");
        },
      },
    } as unknown as Env;
    optIn("u-owner");
    expect(await emailHold(broken, "acme", "k.png", "pii", {})).toBe(0);
  });
});
