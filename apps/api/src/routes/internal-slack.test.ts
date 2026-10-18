import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { respondError } from "../error-response";
import { database, SqliteD1 } from "../../test/helpers/sqlite-d1";

const approveUpload = vi.fn();
vi.mock("../upload-hold-service", () => ({
  approveUpload: (...a: unknown[]) => approveUpload(...a),
}));
vi.mock("../workspace", async (orig) => ({
  ...(await orig<typeof import("../workspace")>()),
  loadWorkspaceRecord: async (_env: unknown, name: string) =>
    name === "acme" ? { provider: "r2", bucket: "b", name } : null,
}));

const { internalSlack } = await import("./internal-slack");

let sqlite: SqliteD1;

beforeEach(() => {
  sqlite = new SqliteD1([
    "migrations/20260822120000_auth_tables.sql",
    "migrations/20261018170000_slack_user_links.sql",
  ]);
  for (const id of ["u-alice", "u-bob"]) {
    sqlite.db
      .prepare("INSERT INTO user (id, name, email, created_at, updated_at) VALUES (?, ?, ?, 0, 0)")
      .run(id, id, `${id}@example.com`);
  }
  sqlite.db
    .prepare(
      "INSERT INTO slack_user_links (team_id, slack_user_id, user_id, linked_at) VALUES ('T0TEAM1', 'U0ALICE', 'u-alice', '2026-10-18')",
    )
    .run();
  approveUpload.mockReset();
  approveUpload.mockResolvedValue({ approved: true });
});

afterEach(() => {
  sqlite.close();
});

/** AUTH answers `/internal/memberships`: alice belongs to acme only. */
function env(): Env {
  const auth = {
    fetch: (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/internal/memberships") {
        const ok =
          url.searchParams.get("userId") === "u-alice" && url.searchParams.get("slug") === "acme";
        return Response.json(
          ok
            ? [
                {
                  organizationId: "o1",
                  organizationSlug: "acme",
                  organizationName: "Acme",
                  role: "member",
                },
              ]
            : [],
        );
      }
      return new Response(null, { status: 404 });
    }) as Fetcher["fetch"],
  };
  return { AUTH: auth, DB: database(sqlite) } as unknown as Env;
}

function app() {
  return new Hono<{ Bindings: Env }>()
    .route("/internal/slack", internalSlack)
    .onError((err, c) => respondError(c, err));
}

function approve(body: Record<string, unknown>, host = "api.internal") {
  return app().request(
    `https://${host}/internal/slack/approve`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    env(),
  );
}

const GOOD = { teamId: "T0TEAM1", slackUserId: "U0ALICE", workspace: "acme", key: "shots/a.png" };

describe("POST /internal/slack/approve", () => {
  it("approves as the linked member", async () => {
    const res = await approve(GOOD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: "shots/a.png", approved: true });
    expect(approveUpload).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "acme" }),
      "acme",
      "shots/a.png",
    );
  });

  it("is unreachable on a public host", async () => {
    expect((await approve(GOOD, "api.uploads.sh")).status).toBe(404);
    expect(approveUpload).not.toHaveBeenCalled();
  });

  it("404s for an unlinked Slack user", async () => {
    expect((await approve({ ...GOOD, slackUserId: "U0MALLORY" })).status).toBe(404);
    expect(approveUpload).not.toHaveBeenCalled();
  });

  it("404s when the linked account is banned", async () => {
    sqlite.db.prepare("UPDATE user SET banned = 1 WHERE id = 'u-alice'").run();
    expect((await approve(GOOD)).status).toBe(404);
    expect(approveUpload).not.toHaveBeenCalled();
  });

  it("404s when the linked account is not a member", async () => {
    sqlite.db.prepare("UPDATE slack_user_links SET user_id = 'u-bob'").run();
    expect((await approve(GOOD)).status).toBe(404);
    expect(approveUpload).not.toHaveBeenCalled();
  });

  it("404s on bad shapes", async () => {
    expect((await approve({ ...GOOD, key: "" })).status).toBe(404);
    expect((await approve({ ...GOOD, workspace: "Acme!" })).status).toBe(404);
    expect(approveUpload).not.toHaveBeenCalled();
  });
});
