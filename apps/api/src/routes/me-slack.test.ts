import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { respondError } from "../error-response";
import { me } from "./me";
import { slackTicketHash } from "./me-slack";
import { SqliteD1, database } from "../../test/helpers/sqlite-d1";

const MIGRATION = "migrations/20261018170000_slack_user_links.sql";
const ALICE = { id: "u-alice", email: "alice@example.com", name: "Alice", role: "user" };
const BOB = { id: "u-bob", email: "bob@example.com", name: "Bob", role: "user" };

const TICKET = "abcdefghijklmnopqrstuvwxyz012345";

let sqlite: SqliteD1;

beforeEach(() => {
  sqlite = new SqliteD1(MIGRATION);
});

afterEach(() => {
  sqlite.close();
});

function env(user: typeof ALICE | null): Env {
  const auth = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (new URL(req.url).pathname === "/api/auth/get-session") {
        return Response.json(user ? { session: {}, user } : null);
      }
      return new Response(null, { status: 404 });
    }) as Fetcher["fetch"],
  };
  return { AUTH: auth, DB: database(sqlite) } as unknown as Env;
}

function app() {
  return new Hono<{ Bindings: Env }>().route("/me", me).onError((err, c) => respondError(c, err));
}

async function insertTicket(
  ticket: string,
  opts: { teamId?: string; slackUserId?: string; expiresInMs?: number } = {},
) {
  const now = Date.now();
  sqlite.db
    .prepare(
      `INSERT INTO slack_link_tickets
         (ticket_hash, team_id, team_name, slack_user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      await slackTicketHash(ticket),
      opts.teamId ?? "T0123ABC",
      "Acme",
      opts.slackUserId ?? "U0456DEF",
      new Date(now).toISOString(),
      new Date(now + (opts.expiresInMs ?? 30 * 60 * 1000)).toISOString(),
    );
}

function linkRows() {
  return sqlite.db.prepare("SELECT * FROM slack_user_links ORDER BY slack_user_id").all();
}

describe("slackTicketHash", () => {
  it("is unpadded base64url SHA-256", async () => {
    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(await slackTicketHash("abc")).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
  });
});

describe("/me/slack auth gate", () => {
  it("401s without a session", async () => {
    const res = await app().request(`/me/slack/connect/${TICKET}`, {}, env(null));
    expect(res.status).toBe(401);
  });
});

describe("GET /me/slack/connect/:ticket", () => {
  it("previews an unexpired ticket without consuming it", async () => {
    await insertTicket(TICKET);
    const res = await app().request(`/me/slack/connect/${TICKET}`, {}, env(ALICE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ teamId: "T0123ABC", teamName: "Acme", slackUserId: "U0456DEF" });
    expect(typeof body.expiresAt).toBe("string");
    expect(sqlite.db.prepare("SELECT COUNT(*) AS n FROM slack_link_tickets").get()).toEqual({
      n: 1,
    });
  });

  it("404s an unknown ticket", async () => {
    const res = await app().request(`/me/slack/connect/${TICKET}`, {}, env(ALICE));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "slack_ticket_not_found",
    );
  });

  it("404s an expired ticket", async () => {
    await insertTicket(TICKET, { expiresInMs: -1000 });
    const res = await app().request(`/me/slack/connect/${TICKET}`, {}, env(ALICE));
    expect(res.status).toBe(404);
  });

  it("404s a badly shaped ticket", async () => {
    const res = await app().request("/me/slack/connect/short", {}, env(ALICE));
    expect(res.status).toBe(404);
  });
});

describe("POST /me/slack/connect/:ticket", () => {
  it("consumes the ticket and links the Slack user to the session user", async () => {
    await insertTicket(TICKET);
    const res = await app().request(`/me/slack/connect/${TICKET}`, { method: "POST" }, env(ALICE));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      teamId: "T0123ABC",
      teamName: "Acme",
      slackUserId: "U0456DEF",
      linked: true,
    });
    expect(linkRows()).toEqual([
      expect.objectContaining({
        team_id: "T0123ABC",
        slack_user_id: "U0456DEF",
        user_id: "u-alice",
        user_email: "alice@example.com",
      }),
    ]);
    expect(sqlite.db.prepare("SELECT COUNT(*) AS n FROM slack_link_tickets").get()).toEqual({
      n: 0,
    });
  });

  it("rejects a reused ticket", async () => {
    await insertTicket(TICKET);
    const first = await app().request(
      `/me/slack/connect/${TICKET}`,
      { method: "POST" },
      env(ALICE),
    );
    expect(first.status).toBe(200);
    const again = await app().request(`/me/slack/connect/${TICKET}`, { method: "POST" }, env(BOB));
    expect(again.status).toBe(404);
    expect(linkRows()).toEqual([expect.objectContaining({ user_id: "u-alice" })]);
  });

  it("rejects an expired ticket and links nothing", async () => {
    await insertTicket(TICKET, { expiresInMs: -1000 });
    const res = await app().request(`/me/slack/connect/${TICKET}`, { method: "POST" }, env(ALICE));
    expect(res.status).toBe(404);
    expect(linkRows()).toEqual([]);
  });

  it("replaces an existing link for the same Slack user", async () => {
    await insertTicket(TICKET);
    await app().request(`/me/slack/connect/${TICKET}`, { method: "POST" }, env(ALICE));
    const second = "zyxwvutsrqponmlkjihgfedcba543210";
    await insertTicket(second);
    const res = await app().request(`/me/slack/connect/${second}`, { method: "POST" }, env(BOB));
    expect(res.status).toBe(200);
    expect(linkRows()).toEqual([
      expect.objectContaining({ user_id: "u-bob", user_email: "bob@example.com" }),
    ]);
  });

  it("cleans up other expired tickets", async () => {
    await insertTicket(TICKET);
    await insertTicket("expiredexpiredexpired0", { expiresInMs: -1000 });
    await app().request(`/me/slack/connect/${TICKET}`, { method: "POST" }, env(ALICE));
    expect(sqlite.db.prepare("SELECT COUNT(*) AS n FROM slack_link_tickets").get()).toEqual({
      n: 0,
    });
  });
});

describe("/me/slack/links", () => {
  async function link(user: typeof ALICE, ticket: string, slackUserId: string) {
    await insertTicket(ticket, { slackUserId });
    const res = await app().request(`/me/slack/connect/${ticket}`, { method: "POST" }, env(user));
    expect(res.status).toBe(200);
  }

  it("lists only the session user's links", async () => {
    await link(ALICE, "aliceticketaliceticket01", "U0AAA111");
    await link(BOB, "bobticketbobticketbob001", "U0BBB222");
    const res = await app().request("/me/slack/links", {}, env(ALICE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { links: Record<string, unknown>[] };
    expect(body.links).toEqual([
      { teamId: "T0123ABC", slackUserId: "U0AAA111", linkedAt: expect.any(String) },
    ]);
  });

  it("deletes the session user's own link", async () => {
    await link(ALICE, "aliceticketaliceticket01", "U0AAA111");
    const res = await app().request(
      "/me/slack/links/T0123ABC/U0AAA111",
      { method: "DELETE" },
      env(ALICE),
    );
    expect(res.status).toBe(204);
    expect(linkRows()).toEqual([]);
  });

  it("404s deleting another user's link and leaves it in place", async () => {
    await link(ALICE, "aliceticketaliceticket01", "U0AAA111");
    const res = await app().request(
      "/me/slack/links/T0123ABC/U0AAA111",
      { method: "DELETE" },
      env(BOB),
    );
    expect(res.status).toBe(404);
    expect(linkRows()).toHaveLength(1);
  });

  it("404s a badly shaped team or user id", async () => {
    const res = await app().request(
      "/me/slack/links/not-a-team/U0AAA111",
      { method: "DELETE" },
      env(ALICE),
    );
    expect(res.status).toBe(404);
  });
});
