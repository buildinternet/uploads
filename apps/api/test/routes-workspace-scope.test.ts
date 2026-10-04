/// <reference types="node" />

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { deleteFileMetadata, replaceFileMetadata } from "../src/file-metadata";
import type { PullsResponse, ReposResponse, ScopeFilesResponse } from "../src/scope-wire";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";
import { FakeKv } from "./fake-kv";
import { FakeR2Bucket } from "./fake-r2";
import { SqliteD1, database } from "./helpers/sqlite-d1";

const TOKEN = "scope-token";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260710140000_workspace_usage.sql",
  "migrations/20260822120100_workspace_usage_shared_subset.sql",
  "migrations/20260712230000_token_minting_user.sql",
  "migrations/20260817180000_token_last_used.sql",
  "migrations/20260925120000_workspace_service_tokens.sql",
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260720120000_github_repo_links.sql",
  "migrations/20260721150000_github_pr_activity.sql",
  "migrations/20260915120000_feeds.sql",
  "migrations/20260915153000_feeds_number.sql",
  "migrations/20261004120000_feeds_source.sql",
  "migrations/20261004120100_pr_activity_title_state.sql",
  "migrations/20261004120200_file_metadata_gh_repo_idx.sql",
];

beforeAll(() => {
  if (!(crypto.subtle as SubtleCrypto & { timingSafeEqual?: unknown }).timingSafeEqual) {
    Object.defineProperty(crypto.subtle, "timingSafeEqual", {
      value: (left: ArrayBufferView, right: ArrayBufferView) => {
        const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
        const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
        if (a.length !== b.length) return false;
        let difference = 0;
        for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
        return difference === 0;
      },
    });
  }
});

let sqlite: SqliteD1;
let bucket: FakeR2Bucket;
let kv: FakeKv;
let env: Parameters<typeof app.request>[2];

afterEach(() => {
  sqlite?.close();
});

beforeEach(async () => {
  sqlite = new SqliteD1(MIGRATIONS);
  bucket = new FakeR2Bucket();
  kv = new FakeKv();
  const record = (prefix: string): WorkspaceRecord => ({
    provider: "r2",
    bucket: "shared",
    binding: "UPLOADS_DEFAULT",
    prefix,
    publicBaseUrl: "https://storage.uploads.sh",
  });
  const records: Record<string, WorkspaceRecord> = {
    alpha: { ...record("alpha/"), tokenHash: await sha256Hex(TOKEN) },
    beta: { ...record("beta/"), tokenHash: await sha256Hex(TOKEN) },
  };
  env = {
    DB: sqlite as unknown as D1Database,
    WEB_ORIGIN: "https://uploads.test",
    REGISTRY: { get: async (key: string) => records[key.slice(3)] ?? null },
    UPLOADS_DEFAULT: bucket,
    WRITE_LIMITER: { limit: async () => ({ success: true }) },
    GITHUB_CACHE: kv,
  } as Parameters<typeof app.request>[2];
});

function request(path: string, init: RequestInit = {}) {
  return app.request(
    path,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
    env,
  );
}

async function getJson<T>(path: string): Promise<T> {
  const res = await request(path);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

async function errorOf(path: string): Promise<{ status: number; code: string | undefined }> {
  const res = await request(path);
  const body = (await res.json()) as { error?: { code?: string } };
  return { status: res.status, code: body.error?.code };
}

/** Upload through the real PUT route, so a `gh.kind=pull` tag creates the rollup row. */
async function putShot(workspace: string, key: string, meta: Record<string, string>) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "image/png",
  };
  for (const [name, value] of Object.entries(meta)) headers[`X-Uploads-Meta-${name}`] = value;
  const response = await app.request(
    `/v1/${workspace}/files/${key}`,
    { method: "PUT", headers, body: PNG },
    env,
  );
  expect(response.status).toBe(201);
}

/** Seed R2 + D1 directly (any key, any content type, optional private). No rollup row. */
async function seedObject(
  key: string,
  meta: Record<string, string>,
  opts: { private?: boolean; contentType?: string; workspace?: string } = {},
) {
  const workspace = opts.workspace ?? "alpha";
  await bucket.put(`${workspace}/${key}`, PNG, {
    httpMetadata: { contentType: opts.contentType ?? "image/png" },
    ...(opts.private ? { customMetadata: { visibility: "private" } } : {}),
  });
  await replaceFileMetadata(database(sqlite), workspace, key, meta);
}

/** Pin every metadata row of `key` to one `updated_at`, for deterministic order. */
function stamp(key: string, iso: string, workspace = "alpha") {
  sqlite.db
    .prepare(`UPDATE file_metadata SET updated_at = ? WHERE workspace = ? AND object_key = ?`)
    .run(iso, workspace, key);
}

function setRollup(ref: string, fields: { lastMediaAt?: string; state?: string | null }) {
  if (fields.lastMediaAt) {
    sqlite.db
      .prepare(`UPDATE github_pr_activity SET last_media_at = ? WHERE ref = ?`)
      .run(fields.lastMediaAt, ref);
  }
  if (fields.state !== undefined) {
    sqlite.db
      .prepare(`UPDATE github_pr_activity SET state = ? WHERE ref = ?`)
      .run(fields.state, ref);
  }
}

const prMeta = (repo: string, number: number): Record<string, string> => ({
  "gh.repo": repo,
  "gh.number": String(number),
  "gh.kind": "pull",
});

/** Bind `repo` to `workspace` in github_repo_links (the member title audience reads this). */
function linkRepo(repo: string, workspace = "alpha") {
  sqlite.db
    .prepare(
      `INSERT INTO github_repo_links (repo_full_name, workspace_name, installation_id, source, created_at)
       VALUES (?, ?, NULL, 'test', '2026-10-01T00:00:00.000Z')`,
    )
    .run(repo, workspace);
}

describe("GET /v1/workspaces/:ws/pulls", () => {
  it("lists PRs newest first with titles, thumbnails, a keyset cursor, and backfills the row", async () => {
    // Linked, so the member ladder reads the `ghref:` cache entry seeded below.
    linkRepo("acme/app");
    await putShot("alpha", "gh/acme/app/pull/1/one.png", prMeta("acme/app", 1));
    await putShot("alpha", "gh/acme/app/pull/2/two.png", prMeta("acme/app", 2));
    await putShot("alpha", "gh/acme/app/pull/3/three.png", prMeta("acme/app", 3));
    // Relative to now: the default window is 90 days, so fixed dates would age out.
    // One base instant, so the seeded and the asserted timestamps are equal.
    const base = Date.now();
    const at = (hours: number) => new Date(base - (10 - hours) * 3_600_000).toISOString();
    setRollup("acme/app#1", { lastMediaAt: at(1) });
    setRollup("acme/app#2", { lastMediaAt: at(2) });
    setRollup("acme/app#3", { lastMediaAt: at(3) });
    kv.store.set("ghref:acme/app#3", {
      value: JSON.stringify({ v: { title: "Add dark mode", state: "open", kind: "pull" } }),
    });

    const first = await getJson<PullsResponse>("/v1/workspaces/alpha/pulls?limit=2");
    expect(first.workspace).toBe("alpha");
    expect(first.pulls.map((p) => p.ref)).toEqual(["acme/app#3", "acme/app#2"]);
    expect(first.pulls[0]).toMatchObject({
      repo: "acme/app",
      number: 3,
      title: "Add dark mode",
      state: "open",
      lastMediaAt: at(3),
    });
    expect(first.pulls[1]).toMatchObject({ number: 2, title: null, state: null });
    expect(first.pulls[0]?.thumbnails).toEqual([
      expect.objectContaining({
        key: "gh/acme/app/pull/3/three.png",
        kind: "screenshot",
        status: "available",
        posterUrl: null,
      }),
    ]);
    expect(first.pulls[0]?.thumbnails[0]?.url).toContain("gh/acme/app/pull/3/three.png");
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await getJson<PullsResponse>(
      `/v1/workspaces/alpha/pulls?limit=2&cursor=${first.nextCursor}`,
    );
    expect(second.pulls.map((p) => p.ref)).toEqual(["acme/app#1"]);
    expect(second.nextCursor).toBeNull();

    expect(
      sqlite.db
        .prepare(`SELECT title, state FROM github_pr_activity WHERE ref = ?`)
        .get("acme/app#3"),
    ).toMatchObject({ title: "Add dark mode", state: "open" });
  });

  it("serves private titles only for repos linked to this workspace (#1065 member audience)", async () => {
    // acme/secret is not linked to alpha: its member-cache entry and a title
    // stored on its rollup row (written while another workspace owned the row)
    // must not reach alpha. State is still served.
    await putShot("alpha", "gh/acme/secret/pull/1/a.png", prMeta("acme/secret", 1));
    kv.store.set("ghref:acme/secret#1", {
      value: JSON.stringify({ v: { title: "Secret plan", state: "open", kind: "pull" } }),
    });
    sqlite.db
      .prepare(`UPDATE github_pr_activity SET title = ?, state = ? WHERE ref = ?`)
      .run("Secret plan", "open", "acme/secret#1");

    const unlinked = await getJson<PullsResponse>("/v1/workspaces/alpha/pulls");
    expect(unlinked.pulls[0]).toMatchObject({ ref: "acme/secret#1", title: null, state: "open" });

    linkRepo("acme/secret");
    const linked = await getJson<PullsResponse>("/v1/workspaces/alpha/pulls");
    expect(linked.pulls[0]).toMatchObject({ ref: "acme/secret#1", title: "Secret plan" });
  });

  it("filters by repo and state; rows with unknown state appear only unfiltered", async () => {
    await putShot("alpha", "gh/acme/app/pull/1/one.png", prMeta("acme/app", 1));
    await putShot("alpha", "gh/acme/app/pull/2/two.png", prMeta("acme/app", 2));
    await putShot("alpha", "gh/acme/app/pull/3/three.png", prMeta("acme/app", 3));
    await putShot("alpha", "gh/acme/site/pull/5/five.png", prMeta("acme/site", 5));
    setRollup("acme/app#1", { state: "merged" });
    setRollup("acme/app#3", { state: "open" });

    const refs = async (query: string) =>
      (await getJson<PullsResponse>(`/v1/workspaces/alpha/pulls${query}`)).pulls
        .map((p) => p.ref)
        .sort();
    expect(await refs("?state=merged")).toEqual(["acme/app#1"]);
    expect(await refs("?state=open")).toEqual(["acme/app#3"]);
    expect(await refs("")).toEqual(["acme/app#1", "acme/app#2", "acme/app#3", "acme/site#5"]);
    expect(await refs("?repo=Acme/Site")).toEqual(["acme/site#5"]);
    expect(await refs("?repo=acme/none")).toEqual([]);
  });

  it("applies type to thumbnails only, on /pulls and /repos; rows are never filtered", async () => {
    await putShot("alpha", "gh/acme/app/pull/1/one.png", prMeta("acme/app", 1));
    await seedObject("gh/acme/app/pull/1/clip.mp4", prMeta("acme/app", 1), {
      contentType: "video/mp4",
    });
    await putShot("alpha", "gh/acme/app/pull/2/two.png", prMeta("acme/app", 2));

    const pulls = await getJson<PullsResponse>("/v1/workspaces/alpha/pulls?type=video");
    const thumbsByRef = new Map(pulls.pulls.map((p) => [p.ref, p.thumbnails.map((t) => t.key)]));
    expect([...thumbsByRef.keys()].sort()).toEqual(["acme/app#1", "acme/app#2"]);
    expect(thumbsByRef.get("acme/app#1")).toEqual(["gh/acme/app/pull/1/clip.mp4"]);
    expect(thumbsByRef.get("acme/app#2")).toEqual([]);

    const repos = await getJson<ReposResponse>("/v1/workspaces/alpha/repos?type=video");
    expect(repos.repos.map((r) => [r.repo, r.thumbnails.map((t) => t.key)])).toEqual([
      ["acme/app", ["gh/acme/app/pull/1/clip.mp4"]],
    ]);

    expect(await errorOf("/v1/workspaces/alpha/pulls?type=gif")).toEqual({
      status: 400,
      code: "invalid_type",
    });
    expect(await errorOf("/v1/workspaces/alpha/repos?type=gif")).toEqual({
      status: 400,
      code: "invalid_type",
    });
  });

  it("excludes PRs idle for over 90 days by default and includes them with all=1", async () => {
    await putShot("alpha", "gh/acme/app/pull/1/old.png", prMeta("acme/app", 1));
    await putShot("alpha", "gh/acme/app/pull/2/new.png", prMeta("acme/app", 2));
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    setRollup("acme/app#1", { lastMediaAt: daysAgo(120) });
    setRollup("acme/app#2", { lastMediaAt: daysAgo(10) });

    const refs = async (query: string) =>
      (await getJson<PullsResponse>(`/v1/workspaces/alpha/pulls${query}`)).pulls.map((p) => p.ref);
    expect(await refs("")).toEqual(["acme/app#2"]);
    expect(await refs("?all=1")).toEqual(["acme/app#2", "acme/app#1"]); // newest first
    // Anything but "1" keeps the window.
    expect(await refs("?all=0")).toEqual(["acme/app#2"]);
    // A PR just inside the window stays listed.
    setRollup("acme/app#1", { lastMediaAt: daysAgo(89) });
    expect(await refs("")).toEqual(["acme/app#2", "acme/app#1"]);
    // The window composes with the repo filter and the cursor.
    setRollup("acme/app#1", { lastMediaAt: daysAgo(120) });
    expect(await refs("?repo=acme/app")).toEqual(["acme/app#2"]);
    const page = await getJson<PullsResponse>("/v1/workspaces/alpha/pulls?all=1&limit=1");
    expect(page.pulls.map((p) => p.ref)).toEqual(["acme/app#2"]);
    const next = await getJson<PullsResponse>(
      `/v1/workspaces/alpha/pulls?all=1&limit=1&cursor=${page.nextCursor}`,
    );
    expect(next.pulls.map((p) => p.ref)).toEqual(["acme/app#1"]);
  });

  it("keeps a PR whose media were all deleted, with no thumbnails (index review focus 1)", async () => {
    await putShot("alpha", "gh/acme/app/pull/9/gone.png", prMeta("acme/app", 9));
    await deleteFileMetadata(database(sqlite), "alpha", "gh/acme/app/pull/9/gone.png");
    const body = await getJson<PullsResponse>("/v1/workspaces/alpha/pulls");
    expect(body.pulls).toHaveLength(1);
    expect(body.pulls[0]).toMatchObject({ ref: "acme/app#9", thumbnails: [] });
  });

  it("rejects a bad state, limit, cursor, and repo, and isolates workspaces", async () => {
    await putShot("alpha", "gh/acme/app/pull/1/one.png", prMeta("acme/app", 1));
    expect(await errorOf("/v1/workspaces/alpha/pulls?state=draft")).toEqual({
      status: 400,
      code: "invalid_state",
    });
    expect(await errorOf("/v1/workspaces/alpha/pulls?limit=0")).toEqual({
      status: 400,
      code: "invalid_limit",
    });
    expect(await errorOf("/v1/workspaces/alpha/pulls?cursor=not-a-cursor")).toEqual({
      status: 400,
      code: "invalid_cursor",
    });
    expect(await errorOf("/v1/workspaces/alpha/pulls?repo=nope")).toEqual({
      status: 400,
      code: "feed_invalid_field",
    });
    expect((await getJson<PullsResponse>("/v1/workspaces/beta/pulls")).pulls).toEqual([]);
  });
});

describe("GET /v1/workspaces/:ws/repos", () => {
  it("lists distinct repos newest first with open PR counts, thumbnails, and a cursor", async () => {
    await putShot("alpha", "gh/acme/app/pull/1/one.png", prMeta("acme/app", 1));
    await putShot("alpha", "gh/acme/app/pull/2/two.png", prMeta("acme/app", 2));
    await putShot("alpha", "gh/acme/site/pull/5/five.png", prMeta("acme/site", 5));
    await seedObject("gh/acme/docs/issues/3/three.png", {
      "gh.repo": "acme/docs",
      "gh.number": "3",
      "gh.kind": "issue",
    });
    stamp("gh/acme/app/pull/1/one.png", "2026-10-01T01:00:00.000Z");
    stamp("gh/acme/app/pull/2/two.png", "2026-10-01T02:00:00.000Z");
    stamp("gh/acme/site/pull/5/five.png", "2026-10-01T03:00:00.000Z");
    stamp("gh/acme/docs/issues/3/three.png", "2026-10-01T04:00:00.000Z");
    setRollup("acme/app#1", { state: "open" });
    setRollup("acme/app#2", { state: "open" });
    setRollup("acme/site#5", { state: "closed" });

    const first = await getJson<ReposResponse>("/v1/workspaces/alpha/repos?limit=2");
    expect(first.workspace).toBe("alpha");
    expect(first.repos.map((r) => r.repo)).toEqual(["acme/docs", "acme/site"]);
    expect(first.repos[0]).toMatchObject({
      lastUpdatedAt: "2026-10-01T04:00:00.000Z",
      openPullCount: 0,
    });
    expect(first.repos[1]).toMatchObject({ openPullCount: 0 });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await getJson<ReposResponse>(
      `/v1/workspaces/alpha/repos?limit=2&cursor=${first.nextCursor}`,
    );
    expect(second.repos).toHaveLength(1);
    expect(second.repos[0]).toMatchObject({
      repo: "acme/app",
      openPullCount: 2,
      lastUpdatedAt: "2026-10-01T02:00:00.000Z",
    });
    expect(second.repos[0]?.thumbnails.map((t) => t.key)).toEqual([
      "gh/acme/app/pull/2/two.png",
      "gh/acme/app/pull/1/one.png",
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it("caps limit at 50 and isolates workspaces", async () => {
    await seedObject("gh/acme/app/pull/1/one.png", prMeta("acme/app", 1));
    expect(await errorOf("/v1/workspaces/alpha/repos?limit=51")).toEqual({
      status: 400,
      code: "invalid_limit",
    });
    expect((await getJson<ReposResponse>("/v1/workspaces/beta/repos")).repos).toEqual([]);
  });
});

describe("GET /v1/workspaces/:ws/scope/:owner/:repo/files", () => {
  it("lists a PR's files newest first, links items to the existing live link, and pages", async () => {
    await seedObject("gh/acme/app/pull/4/a.png", prMeta("acme/app", 4));
    await seedObject("gh/acme/app/pull/4/b.png", prMeta("acme/app", 4));
    await seedObject("gh/acme/app/pull/4/c.mp4", prMeta("acme/app", 4), {
      contentType: "video/mp4",
    });
    await seedObject("gh/acme/app/pull/5/other.png", prMeta("acme/app", 5));
    stamp("gh/acme/app/pull/4/a.png", "2026-10-01T01:00:00.000Z");
    stamp("gh/acme/app/pull/4/b.png", "2026-10-01T02:00:00.000Z");
    stamp("gh/acme/app/pull/4/c.mp4", "2026-10-01T03:00:00.000Z");
    stamp("gh/acme/app/pull/5/other.png", "2026-10-01T04:00:00.000Z");
    const created = await request("/v1/workspaces/alpha/feeds", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app", pr: 4 }),
    });
    const feed = (await created.json()) as { id: string; url: string };

    const page = await getJson<ScopeFilesResponse>(
      "/v1/workspaces/alpha/scope/acme/app/files?number=4&limit=2",
    );
    expect(page).toMatchObject({
      repo: "acme/app",
      number: 4,
      privateCount: 0,
      liveLink: { id: feed.id, url: feed.url, source: "user" },
    });
    expect(page.items.map((i) => i.objectKey)).toEqual([
      "gh/acme/app/pull/4/c.mp4",
      "gh/acme/app/pull/4/b.png",
    ]);
    expect(page.items[0]?.pageUrl).toBe(
      `${feed.url}/${(await sha256Hex("gh/acme/app/pull/4/c.mp4")).slice(0, 32)}`,
    );

    const next = await getJson<ScopeFilesResponse>(
      `/v1/workspaces/alpha/scope/acme/app/files?number=4&limit=2&cursor=${page.nextCursor}`,
    );
    expect(next.items.map((i) => i.objectKey)).toEqual(["gh/acme/app/pull/4/a.png"]);
    expect(next.nextCursor).toBeNull();
    expect(next.privateCount).toBeNull();

    const repoWide = await getJson<ScopeFilesResponse>("/v1/workspaces/alpha/scope/acme/app/files");
    expect(repoWide.number).toBeNull();
    expect(repoWide.items).toHaveLength(4);
    expect(repoWide.liveLink).toBeNull();

    // Scope parity: the live link and the Files view hold the same objects.
    const repoFeed = (await (
      await request("/v1/workspaces/alpha/feeds", {
        method: "POST",
        body: JSON.stringify({ repo: "acme/app" }),
      })
    ).json()) as { items: Array<{ objectKey: string }> };
    expect(repoFeed.items.map((i) => i.objectKey)).toEqual(repoWide.items.map((i) => i.objectKey));
  });

  it("counts private items across the whole scope, ignoring type and page size (review focus 4)", async () => {
    const meta = prMeta("acme/app", 6);
    await seedObject("gh/acme/app/pull/6/p1.png", meta);
    await seedObject("gh/acme/app/pull/6/p2.png", meta);
    await seedObject("gh/acme/app/pull/6/s1.png", meta, { private: true });
    await seedObject("gh/acme/app/pull/6/s2.mp4", meta, {
      private: true,
      contentType: "video/mp4",
    });
    await seedObject("gh/acme/app/pull/6/p3.png", meta);
    stamp("gh/acme/app/pull/6/p1.png", "2026-10-01T01:00:00.000Z");
    stamp("gh/acme/app/pull/6/p2.png", "2026-10-01T02:00:00.000Z");
    stamp("gh/acme/app/pull/6/s1.png", "2026-10-01T03:00:00.000Z");
    stamp("gh/acme/app/pull/6/s2.mp4", "2026-10-01T04:00:00.000Z");
    stamp("gh/acme/app/pull/6/p3.png", "2026-10-01T05:00:00.000Z");

    const videos = await getJson<ScopeFilesResponse>(
      "/v1/workspaces/alpha/scope/acme/app/files?number=6&type=video&limit=1",
    );
    expect(videos.items.map((i) => i.objectKey)).toEqual(["gh/acme/app/pull/6/s2.mp4"]);
    expect(videos.items[0]?.status).toBe("available");
    expect(videos.privateCount).toBe(2);

    const firstPage = await getJson<ScopeFilesResponse>(
      "/v1/workspaces/alpha/scope/acme/app/files?number=6&limit=2",
    );
    expect(firstPage.items.map((i) => i.objectKey)).toEqual([
      "gh/acme/app/pull/6/p3.png",
      "gh/acme/app/pull/6/s2.mp4",
    ]);
    expect(firstPage.privateCount).toBe(2);

    const all = await getJson<ScopeFilesResponse>(
      "/v1/workspaces/alpha/scope/acme/app/files?number=6",
    );
    expect(all.items).toHaveLength(5);
    expect(all.privateCount).toBe(2);
  });

  it("lowercases an owner/repo with dots, dashes, underscores, and capitals (index review focus 2)", async () => {
    await seedObject("gh/foo.bar/my-repo_x/pull/2/shot.png", prMeta("foo.bar/my-repo_x", 2));
    const created = await request("/v1/workspaces/alpha/feeds", {
      method: "POST",
      body: JSON.stringify({ repo: "Foo.Bar/My-Repo_x", pr: 2 }),
    });
    expect(created.status).toBe(201);
    const feedId = ((await created.json()) as { id: string }).id;

    const body = await getJson<ScopeFilesResponse>(
      "/v1/workspaces/alpha/scope/Foo.Bar/My-Repo_x/files?number=2",
    );
    expect(body.repo).toBe("foo.bar/my-repo_x");
    expect(body.items.map((i) => i.objectKey)).toEqual(["gh/foo.bar/my-repo_x/pull/2/shot.png"]);
    expect(body.liveLink?.id).toBe(feedId);
  });

  it("carries the PR's branch, title, and state from this workspace's rollup row", async () => {
    await putShot("alpha", "gh/acme/app/pull/3/a.png", {
      ...prMeta("acme/app", 3),
      "gh.branch": "feat/dark",
    });
    sqlite.db
      .prepare(`UPDATE github_pr_activity SET title = ?, state = ? WHERE ref = ?`)
      .run("Add dark mode", "open", "acme/app#3");

    // Unlinked repo: the stored title is withheld (member title rule), branch and state are not.
    const unlinked = await getJson<ScopeFilesResponse>(
      "/v1/workspaces/alpha/scope/acme/app/files?number=3",
    );
    expect(unlinked.pull).toEqual({ branch: "feat/dark", title: null, state: "open" });

    linkRepo("acme/app");
    const pr = await getJson<ScopeFilesResponse>(
      "/v1/workspaces/alpha/scope/acme/app/files?number=3",
    );
    expect(pr.pull).toEqual({ branch: "feat/dark", title: "Add dark mode", state: "open" });

    // Repo scope, a PR without a rollup row, and another workspace all get null.
    expect(
      (await getJson<ScopeFilesResponse>("/v1/workspaces/alpha/scope/acme/app/files")).pull,
    ).toBeNull();
    expect(
      (await getJson<ScopeFilesResponse>("/v1/workspaces/alpha/scope/acme/app/files?number=99"))
        .pull,
    ).toBeNull();
    expect(
      (await getJson<ScopeFilesResponse>("/v1/workspaces/beta/scope/acme/app/files?number=3")).pull,
    ).toBeNull();
  });

  it("returns an empty scope for a PR whose media were deleted (index review focus 1)", async () => {
    await seedObject("gh/acme/app/pull/9/gone.png", prMeta("acme/app", 9));
    await deleteFileMetadata(database(sqlite), "alpha", "gh/acme/app/pull/9/gone.png");
    const body = await getJson<ScopeFilesResponse>(
      "/v1/workspaces/alpha/scope/acme/app/files?number=9",
    );
    expect(body).toMatchObject({ items: [], nextCursor: null, privateCount: 0, liveLink: null });
  });

  it("rejects a bad type, number, owner/repo, and cursor, and isolates workspaces", async () => {
    await seedObject("gh/acme/app/pull/4/a.png", prMeta("acme/app", 4));
    expect(await errorOf("/v1/workspaces/alpha/scope/acme/app/files?type=gif")).toEqual({
      status: 400,
      code: "invalid_type",
    });
    expect(await errorOf("/v1/workspaces/alpha/scope/acme/app/files?number=abc")).toEqual({
      status: 400,
      code: "feed_invalid_field",
    });
    expect(await errorOf("/v1/workspaces/alpha/scope/a%20b/app/files")).toEqual({
      status: 400,
      code: "feed_invalid_field",
    });
    expect(await errorOf("/v1/workspaces/alpha/scope/acme/app/files?cursor=not-a-cursor")).toEqual({
      status: 400,
      code: "invalid_cursor",
    });
    const beta = await getJson<ScopeFilesResponse>(
      "/v1/workspaces/beta/scope/acme/app/files?number=4",
    );
    expect(beta).toMatchObject({ items: [], liveLink: null, privateCount: 0 });
  });
});
