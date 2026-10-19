import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { respondError } from "../error-response";
import { database, SqliteD1 } from "../../test/helpers/sqlite-d1";

const approveUpload = vi.fn();
vi.mock("../upload-hold-service", () => ({
  approveUpload: (...a: unknown[]) => approveUpload(...a),
  memberName: async () => "Member",
}));
vi.mock("../workspace", async (orig) => ({
  ...(await orig<typeof import("../workspace")>()),
  loadWorkspaceRecord: async (_env: unknown, name: string) =>
    name === "acme" ? { provider: "r2", bucket: "b", name } : null,
}));

/** What the storage walk yields for a name search: key + upload time. */
const walk = vi.fn<(term: string) => { key: string; lastModified?: number }[]>(() => []);
const heldKeysAmong = vi.fn();
vi.mock("../upload-hold-read", () => ({
  heldKeysAmong: (...a: unknown[]) => heldKeysAmong(...a),
}));
/** Objects by key: whether each is private. Missing keys resolve to no lane. */
const objects = new Map<string, { private: boolean }>();
vi.mock("../storage", () => ({
  storage: async () => ({
    async *search(term: string) {
      yield* walk(term);
    },
  }),
  objectPublicUrls: (_env: unknown, _cfg: unknown, key: string) => ({
    url: `https://cdn.example/${key}`,
    embedUrl: null,
  }),
  resolveObjectLaneWithHead: async (_env: unknown, _ws: unknown, key: string) => {
    const o = objects.get(key);
    if (!o) return null;
    return {
      config: {},
      head: {
        type: key.endsWith(".png") ? "image/png" : "video/mp4",
        metadata: o.private ? { visibility: "private" } : {},
      },
    };
  },
}));

const { internalSlack } = await import("./internal-slack");

let sqlite: SqliteD1;

beforeEach(() => {
  sqlite = new SqliteD1([
    "migrations/20260822120000_auth_tables.sql",
    "migrations/20261018170000_slack_user_links.sql",
    "migrations/20261018160000_slack_installations.sql",
    "migrations/20261018190000_slack_workspace_bindings.sql",
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
      "Member",
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

describe("POST /internal/slack/search", () => {
  function search(body: Record<string, unknown>, host = "api.internal") {
    return app().request(
      `https://${host}/internal/slack/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      env(),
    );
  }

  beforeEach(() => {
    sqlite.db
      .prepare(
        `INSERT INTO slack_installations (team_id, team_name, app_id, scopes, installed_at, updated_at)
         VALUES ('T0TEAM1', 'Acme', 'A1', 'commands', '2026-10-18', '2026-10-18')`,
      )
      .run();
    objects.clear();
    walk.mockReset();
    walk.mockReturnValue([]);
    heldKeysAmong.mockReset();
    heldKeysAmong.mockResolvedValue(new Set(["shots/held.png"]));
  });

  function bind(workspace = "acme") {
    sqlite.db
      .prepare(
        "INSERT INTO slack_workspace_bindings (team_id, workspace, bound_by_user_id, created_at) VALUES ('T0TEAM1', ?, 'u-alice', '2026-10-18')",
      )
      .run(workspace);
  }

  it("says when the Slack team isn't bound, without searching", async () => {
    const res = await search({ teamId: "T0TEAM1", term: "login" });
    expect(await res.json()).toEqual({ bound: false, results: [], truncated: false });
    expect(walk).not.toHaveBeenCalled();
  });

  it("returns the newest public, unheld matches from bound workspaces", async () => {
    bind();
    for (const key of [
      "shots/login.png",
      "shots/secret-login.png",
      "shots/held.png",
      "a/login.mp4",
    ])
      objects.set(key, { private: key.includes("secret") });
    walk.mockReturnValue([
      { key: "a/login.mp4", lastModified: 1_000 },
      { key: "shots/gone.png", lastModified: 5_000 },
      { key: "shots/held.png", lastModified: 4_000 },
      { key: "shots/login.png", lastModified: 3_000 },
      { key: "shots/secret-login.png", lastModified: 2_000 },
      { key: "_internal/posters/a/login.mp4.jpg", lastModified: 9_000 },
    ]);
    const res = await search({ teamId: "T0TEAM1", term: "  Login " });
    expect(await res.json()).toEqual({
      bound: true,
      results: [
        {
          workspace: "acme",
          key: "shots/login.png",
          imageUrl: "https://cdn.example/shots/login.png",
          uploaded: 3_000,
        },
        // Older, and not an image, so no thumbnail.
        { workspace: "acme", key: "a/login.mp4", uploaded: 1_000 },
      ],
      truncated: false,
    });
    expect(walk).toHaveBeenCalledWith("login");
  });

  it("returns at most five", async () => {
    bind();
    const keys = Array.from({ length: 8 }, (_, i) => `shots/login-${i}.png`);
    for (const key of keys) objects.set(key, { private: false });
    walk.mockReturnValue(keys.map((key, i) => ({ key, lastModified: i })));
    const res = await search({ teamId: "T0TEAM1", term: "login" });
    const body = (await res.json()) as { results: { key: string }[] };
    expect(body.results.map((r) => r.key)).toEqual(keys.slice(3).reverse());
  });

  it("ignores bindings once the app is uninstalled", async () => {
    bind();
    sqlite.db.prepare("UPDATE slack_installations SET revoked_at = '2026-10-18'").run();
    const res = await search({ teamId: "T0TEAM1", term: "login" });
    expect(((await res.json()) as { bound: boolean }).bound).toBe(false);
  });

  it("is unreachable on a public host and 404s bad shapes", async () => {
    bind();
    expect((await search({ teamId: "T0TEAM1", term: "x" }, "api.uploads.sh")).status).toBe(404);
    expect((await search({ teamId: "nope", term: "x" })).status).toBe(404);
    expect((await search({ teamId: "T0TEAM1", term: " " })).status).toBe(404);
    expect(walk).not.toHaveBeenCalled();
  });
});
