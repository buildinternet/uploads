/**
 * Hosted `list_activity` and `list_repo_files`. The SQL lives in the API
 * suite. These tests pin the tool contract: which rows the handler returns,
 * the title gate, the argument filters, the read-scope gate, and that a
 * read does not create a feed.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "@uploads/api/workspace";
import { SqliteD1 } from "../../api/test/helpers/sqlite-d1";
import { FakeR2Bucket } from "@uploads/storage/test/fake-r2";

const TOKEN = "up_test-ws_legacy-token-value";
const WRITE_TOKEN = "up_test-ws_write-only-token";
const WS = "test-ws";

const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260712230000_token_minting_user.sql",
  "migrations/20260817180000_token_last_used.sql",
  "migrations/20260925120000_workspace_service_tokens.sql",
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20261004120200_file_metadata_gh_repo_idx.sql",
  "migrations/20260720120000_github_repo_links.sql",
  "migrations/20260721150000_github_pr_activity.sql",
  "migrations/20261004120100_pr_activity_title_state.sql",
  "migrations/20260915120000_feeds.sql",
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

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function tag(
  sqlite: SqliteD1,
  workspace: string,
  key: string,
  meta: Record<string, string>,
  updatedAt: string,
) {
  const statement = sqlite.db.prepare(
    `INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const [metaKey, metaValue] of Object.entries(meta)) {
    statement.run(workspace, key, metaKey, metaValue, updatedAt);
  }
}

function activity(
  sqlite: SqliteD1,
  row: {
    repo: string;
    number: number;
    workspace: string;
    at: string;
    title: string;
    state?: string;
    branch?: string;
  },
) {
  sqlite.db
    .prepare(
      `INSERT INTO github_pr_activity
         (ref, repo_full_name, pr_number, branch, workspace_name, media_count,
          first_media_at, last_media_at, title, state)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    )
    .run(
      `${row.repo}#${row.number}`,
      row.repo,
      row.number,
      row.branch ?? null,
      row.workspace,
      row.at,
      row.at,
      row.title,
      row.state ?? "open",
    );
}

async function makeEnv(opts: { writeOnlyToken?: boolean } = {}) {
  const sqlite = new SqliteD1(MIGRATIONS);
  const tokenHash = await sha256Hex(TOKEN);
  if (opts.writeOnlyToken) {
    sqlite.db
      .prepare(
        `INSERT INTO auth_tokens (id, workspace, token_hash, scopes, created_at)
         VALUES ('write-only', ?, ?, ?, '2026-07-10T00:00:00.000Z')`,
      )
      .run(WS, await sha256Hex(WRITE_TOKEN), JSON.stringify(["files:write"]));
  }
  sqlite.db
    .prepare(
      `INSERT INTO github_repo_links
         (repo_full_name, workspace_name, installation_id, source, created_at)
       VALUES ('acme/widgets', ?, NULL, 'test', '2026-10-01T00:00:00.000Z')`,
    )
    .run(WS);

  tag(
    sqlite,
    WS,
    "gh/acme/widgets/pull/7/new.png",
    { "gh.repo": "acme/widgets", "gh.number": "7", path: "/settings", state: "after" },
    "2026-10-09T00:00:00.000Z",
  );
  tag(
    sqlite,
    WS,
    "gh/acme/widgets/pull/7/notes.pdf",
    { "gh.repo": "acme/widgets", "gh.number": "7", path: "/docs" },
    "2026-10-08T00:00:00.000Z",
  );
  tag(
    sqlite,
    WS,
    "gh/acme/widgets/pull/9/other.png",
    { "gh.repo": "acme/widgets", "gh.number": "9", path: "/billing" },
    "2026-10-07T00:00:00.000Z",
  );
  tag(
    sqlite,
    WS,
    "gh/elsewhere/app/shot.png",
    { "gh.repo": "elsewhere/app" },
    "2026-10-01T00:00:00.000Z",
  );
  tag(
    sqlite,
    "other-ws",
    "gh/acme/widgets/secret.png",
    { "gh.repo": "acme/widgets" },
    "2026-10-11T00:00:00.000Z",
  );

  activity(sqlite, {
    repo: "acme/widgets",
    number: 7,
    workspace: WS,
    at: isoDaysAgo(2),
    title: "Widgets refresh",
    branch: "feature/widgets",
  });
  activity(sqlite, {
    repo: "other/app",
    number: 3,
    workspace: WS,
    at: isoDaysAgo(5),
    title: "Secret title",
    branch: "feature/secret",
  });
  activity(sqlite, {
    repo: "acme/widgets",
    number: 1,
    workspace: WS,
    at: isoDaysAgo(120),
    title: "Old work",
  });
  activity(sqlite, {
    repo: "no/one",
    number: 1,
    workspace: "other-ws",
    at: isoDaysAgo(1),
    title: "Foreign",
  });

  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "test-bucket",
    binding: "UPLOADS",
    publicBaseUrl: "https://storage.uploads.sh",
    tokenHash,
  };
  const env = {
    REGISTRY: {
      get: async (key: string) => (key === `ws:${WS}` ? record : null),
    },
    DB: sqlite,
    UPLOADS: new FakeR2Bucket(),
  } as unknown as Env;
  return { env, sqlite };
}

async function callTool(env: Env, name: string, args: Record<string, unknown>, token = TOKEN) {
  const response = await app.request(
    `/${WS}/mcp`,
    {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
    },
    env,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result: {
      isError: boolean;
      structuredContent?: Record<string, unknown>;
      content: { type: string; text: string }[];
    };
  };
  return body.result;
}

function pageField<T>(result: { structuredContent?: Record<string, unknown> }, key: string): T {
  const value = result.structuredContent?.[key];
  if (value === undefined) throw new Error(`missing ${key}`);
  return value as T;
}

describe("list_activity and list_repo_files", () => {
  let sqlite: SqliteD1 | undefined;
  afterEach(() => {
    sqlite?.close();
    sqlite = undefined;
  });

  it("lists recent pull activity, withholds unlinked titles, and pages", async () => {
    const env = await makeEnv();
    sqlite = env.sqlite;
    const page = await callTool(env.env, "list_activity", { limit: 1 });
    expect(page.isError).toBe(false);
    expect(Object.keys(page.structuredContent ?? {}).sort()).toEqual(["by", "cursor", "pulls"]);
    expect(page.structuredContent).toMatchObject({
      by: "pull",
      pulls: [
        {
          ref: "acme/widgets#7",
          repo: "acme/widgets",
          number: 7,
          branch: "feature/widgets",
          state: "open",
          title: "Widgets refresh",
        },
      ],
    });
    expect(page.structuredContent?.cursor).toEqual(expect.any(String));

    const next = await callTool(env.env, "list_activity", {
      limit: 1,
      cursor: page.structuredContent?.cursor,
    });
    expect(next.structuredContent).toMatchObject({
      by: "pull",
      pulls: [{ ref: "other/app#3", title: null, branch: "feature/secret" }],
      cursor: null,
    });

    const rest = await callTool(env.env, "list_activity", {});
    const refs = pageField<{ ref: string }[]>(rest, "pulls").map((row) => row.ref);
    expect(refs).toEqual(["acme/widgets#7", "other/app#3"]);

    const all = await callTool(env.env, "list_activity", { all: true });
    expect(pageField<{ ref: string }[]>(all, "pulls").map((row) => row.ref)).toEqual([
      "acme/widgets#7",
      "other/app#3",
      "acme/widgets#1",
    ]);
  });

  it("lists repos by newest tagged file and rejects pull-only filters", async () => {
    const env = await makeEnv();
    sqlite = env.sqlite;
    const result = await callTool(env.env, "list_activity", { by: "repo" });
    expect(result.isError).toBe(false);
    expect(Object.keys(result.structuredContent ?? {}).sort()).toEqual(["by", "cursor", "repos"]);
    expect(result.structuredContent).toEqual({
      by: "repo",
      repos: [
        { repo: "acme/widgets", lastUpdatedAt: "2026-10-09T00:00:00.000Z" },
        { repo: "elsewhere/app", lastUpdatedAt: "2026-10-01T00:00:00.000Z" },
      ],
      cursor: null,
    });

    const rejected = await callTool(env.env, "list_activity", { by: "repo", state: "open" });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]?.text).toMatch(/apply only when by is pull/);
  });

  it("lists one repo's tagged files newest first, filtered, without creating a feed", async () => {
    const env = await makeEnv();
    sqlite = env.sqlite;
    const result = await callTool(env.env, "list_repo_files", { repo: "Acme/Widgets" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      cursor: null,
      items: [
        {
          key: "gh/acme/widgets/pull/7/new.png",
          url: "https://storage.uploads.sh/gh/acme/widgets/pull/7/new.png",
          embedUrl: "https://embed.uploads.sh/gh/acme/widgets/pull/7/new.png",
          updatedAt: "2026-10-09T00:00:00.000Z",
          path: "/settings",
          state: "after",
          kind: "screenshot",
        },
        {
          key: "gh/acme/widgets/pull/7/notes.pdf",
          path: "/docs",
          state: null,
          kind: "other",
        },
        {
          key: "gh/acme/widgets/pull/9/other.png",
          path: "/billing",
          kind: "screenshot",
        },
      ],
    });

    const screenshots = await callTool(env.env, "list_repo_files", {
      repo: "acme/widgets",
      type: "screenshot",
    });
    expect(pageField<{ key: string }[]>(screenshots, "items").map((item) => item.key)).toEqual([
      "gh/acme/widgets/pull/7/new.png",
      "gh/acme/widgets/pull/9/other.png",
    ]);

    const pdfs = await callTool(env.env, "list_repo_files", {
      repo: "acme/widgets",
      type: "other",
    });
    expect(pageField<{ key: string }[]>(pdfs, "items").map((item) => item.key)).toEqual([
      "gh/acme/widgets/pull/7/notes.pdf",
    ]);

    const pr = await callTool(env.env, "list_repo_files", { repo: "acme/widgets", pr: 7 });
    expect(pageField<{ key: string }[]>(pr, "items").map((item) => item.key)).toEqual([
      "gh/acme/widgets/pull/7/new.png",
      "gh/acme/widgets/pull/7/notes.pdf",
    ]);

    const path = await callTool(env.env, "list_repo_files", {
      repo: "acme/widgets",
      path: "/settings",
    });
    expect(pageField<{ key: string }[]>(path, "items").map((item) => item.key)).toEqual([
      "gh/acme/widgets/pull/7/new.png",
    ]);

    const first = await callTool(env.env, "list_repo_files", { repo: "acme/widgets", limit: 1 });
    const second = await callTool(env.env, "list_repo_files", {
      repo: "acme/widgets",
      limit: 1,
      cursor: first.structuredContent?.cursor,
    });
    expect(pageField<{ key: string }[]>(second, "items")[0]?.key).toBe(
      "gh/acme/widgets/pull/7/notes.pdf",
    );

    const feeds = sqlite!.db.prepare("SELECT COUNT(*) AS n FROM feeds").get() as { n: number };
    expect(feeds.n).toBe(0);
  });

  it("requires files:read", async () => {
    const env = await makeEnv({ writeOnlyToken: true });
    sqlite = env.sqlite;
    for (const name of ["list_activity", "list_repo_files"] as const) {
      const result = await callTool(env.env, name, { repo: "acme/widgets" }, WRITE_TOKEN);
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toBe("forbidden: requires files:read scope");
    }
  });

  it("rejects a page size past the Files view cap", async () => {
    const env = await makeEnv();
    sqlite = env.sqlite;
    const pulls = await callTool(env.env, "list_activity", { limit: 101 });
    expect(pulls.isError).toBe(true);
    expect(pulls.content[0]?.text).toMatch(/between 1 and 100/);
    const repos = await callTool(env.env, "list_activity", { by: "repo", limit: 51 });
    expect(repos.content[0]?.text).toMatch(/between 1 and 50/);
    const files = await callTool(env.env, "list_repo_files", { repo: "acme/widgets", limit: 101 });
    expect(files.content[0]?.text).toMatch(/between 1 and 100/);
  });
});
