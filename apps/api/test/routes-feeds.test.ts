/// <reference types="node" />

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";
import { FakeR2Bucket } from "./fake-r2";
import { FakeKv } from "./fake-kv";
import { GITHUB_APP_CFG_ENV } from "./github-app-env";
import { withGlobalFetch } from "./helpers/github-fetch-fakes";
import { SqliteD1, database } from "./helpers/sqlite-d1";
import { replaceFileMetadata } from "../src/file-metadata";
import type { PublicFeedItemPage } from "../src/scope-wire";
import { FakeCacheStorage } from "./helpers/fake-cache-storage";
import { LIVE_LINK_INDEX_CACHE_NAME, LIVE_LINK_INDEX_TTL_SECONDS } from "../src/live-link-index";

const TOKEN = "feed-token";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260710140000_workspace_usage.sql",
  "migrations/20260822120100_workspace_usage_shared_subset.sql",
  "migrations/20260712230000_token_minting_user.sql",
  "migrations/20260817180000_token_last_used.sql",
  "migrations/20260925120000_workspace_service_tokens.sql",
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260915120000_feeds.sql",
  "migrations/20260915153000_feeds_number.sql",
  "migrations/20261004120000_feeds_source.sql",
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
let records: Record<string, WorkspaceRecord>;
let env: Parameters<typeof app.request>[2];

afterEach(() => {
  sqlite?.close();
});

beforeEach(async () => {
  sqlite = new SqliteD1(MIGRATIONS);
  bucket = new FakeR2Bucket();
  records = {
    alpha: {
      provider: "r2",
      bucket: "shared",
      binding: "UPLOADS_DEFAULT",
      prefix: "alpha/",
      publicBaseUrl: "https://storage.uploads.sh",
      tokenHash: await sha256Hex(TOKEN),
    },
    beta: {
      provider: "r2",
      bucket: "shared",
      binding: "UPLOADS_DEFAULT",
      prefix: "beta/",
      publicBaseUrl: "https://storage.uploads.sh",
      tokenHash: await sha256Hex(TOKEN),
    },
    // No public base URL: objects are reachable only through signed URLs.
    gamma: {
      provider: "r2",
      bucket: "shared",
      binding: "UPLOADS_DEFAULT",
      prefix: "gamma/",
      tokenHash: await sha256Hex(TOKEN),
    },
  };
  env = {
    DB: sqlite as unknown as D1Database,
    WEB_ORIGIN: "https://uploads.test",
    REGISTRY: { get: async (key: string) => records[key.slice(3)] ?? null },
    UPLOADS_DEFAULT: bucket,
    WRITE_LIMITER: { limit: async () => ({ success: true }) },
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

async function putShot(workspace: string, key: string, meta: Record<string, string>) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "image/png",
  };
  for (const [name, value] of Object.entries(meta)) {
    headers[`X-Uploads-Meta-${name}`] = value;
  }
  const response = await app.request(
    `/v1/${workspace}/files/${key}`,
    { method: "PUT", headers, body: PNG },
    env,
  );
  expect(response.status).toBe(201);
  return response.json() as Promise<{ url: string }>;
}

describe("feed routes", () => {
  it("creates a capability URL, hydrates newest-first items, and hides keys on the public page", async () => {
    await putShot("alpha", "gh/acme/app/pull/1/old.png", {
      "gh.repo": "acme/app",
      path: "/settings",
    });
    // Force the first shot older so the second is newest.
    sqlite.db
      .prepare(`UPDATE file_metadata SET updated_at = ? WHERE object_key = ?`)
      .run("2026-09-01T00:00:00.000Z", "gh/acme/app/pull/1/old.png");
    await putShot("alpha", "gh/acme/app/pull/2/new.png", {
      "gh.repo": "acme/app",
      path: "/billing",
      state: "after",
    });
    await putShot("alpha", "gh/acme/app/branch/feat/shadow.png", {
      "gh.repo": "acme/app",
      "gh.status": "promoted",
    });

    const created = await request("/v1/workspaces/alpha/feeds", {
      method: "POST",
      body: JSON.stringify({ repo: "Acme/App" }),
    });
    expect(created.status).toBe(201);
    const feed = (await created.json()) as {
      id: string;
      url: string;
      repo: string;
      path: string | null;
      number: number | null;
      kind: "pull" | "issue" | null;
      title: string;
      workspace: string;
      items: Array<{
        objectKey: string;
        filename: string;
        path: string | null;
        state: string | null;
        url: string | null;
      }>;
    };
    expect(feed.id).toMatch(/^feed_[A-Za-z0-9_-]{22}$/);
    expect(feed.url).toBe(`https://uploads.test/c/${feed.id}`);
    expect(feed.repo).toBe("acme/app");
    expect(feed.path).toBeNull();
    expect(feed.number).toBeNull();
    expect(feed.kind).toBeNull();
    expect(feed.title).toBe("acme/app");
    expect(feed.workspace).toBe("alpha");
    expect(feed.items.map((item) => item.filename)).toEqual(["new.png", "old.png"]);
    expect(feed.items[0]).toMatchObject({
      objectKey: "gh/acme/app/pull/2/new.png",
      path: "/billing",
      state: "after",
      pageUrl: `https://uploads.test/c/${feed.id}/${(await sha256Hex("gh/acme/app/pull/2/new.png")).slice(0, 32)}`,
    });

    const reused = await request("/v1/workspaces/alpha/feeds", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app" }),
    });
    expect(reused.status).toBe(200);
    expect(((await reused.json()) as { id: string }).id).toBe(feed.id);

    const publicFeed = await app.request(`/public/feeds/${feed.id}`, {}, env);
    expect(publicFeed.status).toBe(200);
    const body = (await publicFeed.json()) as {
      id: string;
      repo: string;
      workspace?: string;
      items: Array<{ objectKey?: string; filename: string; url: string | null }>;
    };
    expect(body).toMatchObject({ id: feed.id, repo: "acme/app", title: "acme/app" });
    expect(body).not.toHaveProperty("workspace");
    expect(body.items.map((item) => item.filename)).toEqual(["new.png", "old.png"]);
    expect(body.items[0]?.url).toContain("new.png");
    expect(body.items[0]).not.toHaveProperty("objectKey");
    expect(body.items[0]).not.toHaveProperty("pageUrl");

    expect((await request(`/v1/workspaces/beta/feeds/${feed.id}`)).status).toBe(404);
    expect(
      (await app.request(`/public/feeds/${feed.id.replace("feed_", "gal_")}`, {}, env)).status,
    ).toBe(404);
  });

  it("filters by path and lists/deletes on the owner routes", async () => {
    await putShot("alpha", "gh/acme/app/pull/1/settings.png", {
      "gh.repo": "acme/app",
      path: "/settings",
    });
    await putShot("alpha", "gh/acme/app/pull/1/billing.png", {
      "gh.repo": "acme/app",
      path: "/billing",
    });

    const created = await request("/v1/alpha/feeds", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app", path: "/settings" }),
    });
    expect(created.status).toBe(201);
    const feed = (await created.json()) as {
      id: string;
      title: string;
      path: string | null;
      items: Array<{ filename: string }>;
    };
    expect(feed.title).toBe("acme/app · /settings");
    expect(feed.path).toBe("/settings");
    expect(feed.items.map((item) => item.filename)).toEqual(["settings.png"]);

    const listed = await request("/v1/workspaces/alpha/feeds");
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as {
      feeds: Array<{ id: string; url: string }>;
      nextCursor: null;
    };
    expect(page.feeds).toHaveLength(1);
    expect(page.feeds[0]?.id).toBe(feed.id);
    expect(page.nextCursor).toBeNull();

    const deleted = await request(`/v1/workspaces/alpha/feeds/${feed.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true, id: feed.id });
    expect((await request(`/v1/workspaces/alpha/feeds/${feed.id}`)).status).toBe(404);
    expect((await app.request(`/public/feeds/${feed.id}`, {}, env)).status).toBe(404);
  });

  it("rejects a missing repo and an unknown feed with uniform 404s", async () => {
    const missing = await request("/v1/workspaces/alpha/feeds", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      error: { code: "feed_invalid_field", details: { field: "repo" } },
    });
    expect((await request("/v1/workspaces/alpha/feeds/feed_xxxxxxxxxxxxxxxxxxxxxx")).status).toBe(
      404,
    );
  });

  it("scopes a feed to one pull request and reuses that slot", async () => {
    await putShot("alpha", "gh/acme/app/pull/1/one.png", {
      "gh.repo": "acme/app",
      "gh.number": "1",
      "gh.kind": "pull",
    });
    await putShot("alpha", "gh/acme/app/pull/2/two.png", {
      "gh.repo": "acme/app",
      "gh.number": "2",
      "gh.kind": "pull",
    });

    const created = await request("/v1/workspaces/alpha/feeds", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app", pr: 1 }),
    });
    expect(created.status).toBe(201);
    const feed = (await created.json()) as {
      id: string;
      title: string;
      number: number | null;
      kind: string | null;
      items: Array<{ filename: string }>;
    };
    expect(feed.title).toBe("acme/app#1");
    expect(feed.number).toBe(1);
    expect(feed.kind).toBe("pull");
    expect(feed.items.map((item) => item.filename)).toEqual(["one.png"]);

    const reused = await request("/v1/workspaces/alpha/feeds", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app", number: 1 }),
    });
    expect(reused.status).toBe(200);
    expect(((await reused.json()) as { id: string }).id).toBe(feed.id);

    const publicFeed = await app.request(`/public/feeds/${feed.id}`, {}, env);
    expect(publicFeed.status).toBe(200);
    const body = (await publicFeed.json()) as {
      title: string;
      number: number | null;
      kind: string | null;
      workspace?: string;
      items: Array<{ filename: string; objectKey?: string }>;
    };
    expect(body).toMatchObject({ title: "acme/app#1", number: 1, kind: "pull" });
    expect(body).not.toHaveProperty("workspace");
    // No GitHub App configured in this env: the field is present, values null.
    expect((body as unknown as { github: unknown }).github).toEqual({ title: null, state: null });
    expect(body.items.map((item) => item.filename)).toEqual(["one.png"]);
    expect(body.items[0]).not.toHaveProperty("objectKey");
  });

  describe("public PR label", () => {
    async function prFeedWithApp(repo: string, fetchImpl: typeof fetch) {
      const kv = new FakeKv();
      kv.store.set("ghtok:777", { value: "ghs_home" });
      // A member-audience entry the public page must never read.
      kv.store.set(`ghref:${repo}#1`, {
        value: JSON.stringify({ v: { title: "Member-only title", state: "open", kind: "pull" } }),
      });
      Object.assign(env as object, { GITHUB_CACHE: kv, ...GITHUB_APP_CFG_ENV });
      await putShot("alpha", `gh/${repo}/pull/1/one.png`, {
        "gh.repo": repo,
        "gh.number": "1",
        "gh.kind": "pull",
        "gh.title": "Stamped title",
      });
      const created = await request("/v1/workspaces/alpha/feeds", {
        method: "POST",
        body: JSON.stringify({ repo, pr: 1 }),
      });
      const { id } = (await created.json()) as { id: string };
      const res = await withGlobalFetch(fetchImpl, async () =>
        app.request(`/public/feeds/${id}`, {}, env),
      );
      expect(res.status).toBe(200);
      return res.text();
    }

    it("never returns a private repo's title, member-cached title, or stamped title", async () => {
      const text = await prFeedWithApp("acme/secret", (async (input: RequestInfo | URL) =>
        String(input).includes("/issues/")
          ? Response.json({ title: "Secret roadmap", state: "open" })
          : Response.json({ private: true })) as typeof fetch);
      expect((JSON.parse(text) as { github: unknown }).github).toEqual({
        title: null,
        state: null,
      });
      expect(text).not.toContain("Secret roadmap");
      expect(text).not.toContain("Member-only title");
      expect(text).not.toContain("Stamped title");
    });

    it("returns the live title and state for a verified-public repo", async () => {
      const text = await prFeedWithApp("acme/open", (async (input: RequestInfo | URL) =>
        String(input).includes("/issues/")
          ? Response.json({
              title: "Fix nav",
              state: "closed",
              pull_request: { merged_at: "2026-10-01T00:00:00Z" },
            })
          : Response.json({ private: false })) as typeof fetch);
      expect((JSON.parse(text) as { github: unknown }).github).toEqual({
        title: "Fix nav",
        state: "merged",
      });
    });
  });

  it("creates a distinct feed URL per repo in one workspace and reuses the same repo", async () => {
    const first = await request("/v1/workspaces/alpha/feeds", {
      method: "POST",
      body: JSON.stringify({ repo: "buildinternet/uploads" }),
    });
    const second = await request("/v1/workspaces/alpha/feeds", {
      method: "POST",
      body: JSON.stringify({ repo: "buildinternet/releases" }),
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const uploads = (await first.json()) as { id: string; url: string; repo: string };
    const releases = (await second.json()) as { id: string; url: string; repo: string };
    expect(uploads.repo).toBe("buildinternet/uploads");
    expect(releases.repo).toBe("buildinternet/releases");
    expect(uploads.id).not.toBe(releases.id);
    expect(uploads.url).not.toBe(releases.url);
    expect(uploads.url).toBe(`https://uploads.test/c/${uploads.id}`);
    expect(releases.url).toBe(`https://uploads.test/c/${releases.id}`);

    const again = await request("/v1/workspaces/alpha/feeds", {
      method: "POST",
      body: JSON.stringify({ repo: "buildinternet/uploads" }),
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { id: string; url: string }).url).toBe(uploads.url);

    const repoPublic = await app.request(`/public/feeds/${uploads.id}`, {}, env);
    expect(((await repoPublic.json()) as { github: unknown }).github).toBeNull();
  });

  it("reports who created each feed on the owner DTOs and ignores a client-sent source", async () => {
    const created = await request("/v1/workspaces/alpha/feeds", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app", source: "comment" }),
    });
    expect(created.status).toBe(201);
    const feed = (await created.json()) as { id: string; source: string | null };
    expect(feed.source).toBe("user");

    const listed = await request("/v1/workspaces/alpha/feeds");
    const page = (await listed.json()) as { feeds: Array<{ id: string; source: string | null }> };
    expect(page.feeds).toEqual([expect.objectContaining({ id: feed.id, source: "user" })]);

    const single = await request(`/v1/workspaces/alpha/feeds/${feed.id}`);
    expect(((await single.json()) as { source: string | null }).source).toBe("user");

    const publicFeed = await app.request(`/public/feeds/${feed.id}`, {}, env);
    expect(await publicFeed.json()).not.toHaveProperty("source");
  });

  it("ignores a client-sent source: bearer-created feeds are user feeds", async () => {
    const res = await request("/v1/workspaces/alpha/feeds", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app", pr: 3, source: "comment" }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { source: string | null }).source).toBe("user");
  });

  it("refuses a live link on a workspace with no public base URL and saves no row", async () => {
    // Both an empty scope and one with files: a live link could serve neither.
    await putShot("gamma", "gh/acme/app/pull/1/a.png", { "gh.repo": "acme/app" });
    for (const body of [{ repo: "acme/app", pr: 1 }, { repo: "acme/empty" }]) {
      const created = await request("/v1/workspaces/gamma/feeds", {
        method: "POST",
        body: JSON.stringify(body),
      });
      expect(created.status).toBe(503);
      expect(await created.json()).toMatchObject({ error: { code: "feed_object_not_public" } });
    }
    const list = await request("/v1/workspaces/gamma/feeds");
    expect(((await list.json()) as { feeds: unknown[] }).feeds).toEqual([]);
  });

  it("creates 60 PR-scoped feeds over the API and caps only repo-scoped feeds at 50", async () => {
    for (let n = 1; n <= 60; n++) {
      const created = await request("/v1/workspaces/alpha/feeds", {
        method: "POST",
        body: JSON.stringify({ repo: "acme/web", pr: n }),
      });
      expect(created.status).toBe(201);
    }
    for (let i = 0; i < 50; i++) {
      const created = await request("/v1/workspaces/alpha/feeds", {
        method: "POST",
        body: JSON.stringify({ repo: `acme/app${i}` }),
      });
      expect(created.status).toBe(201);
    }
    const overflow = await request("/v1/workspaces/alpha/feeds", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/overflow" }),
    });
    expect(overflow.status).toBe(409);
    expect(await overflow.json()).toMatchObject({
      error: { code: "feed_limit_reached", details: { limit: 50 } },
    });
    // PR-scoped creates are still accepted after the repo quota is full.
    const next = await request("/v1/workspaces/alpha/feeds", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/web", pr: 61 }),
    });
    expect(next.status).toBe(201);
  });
});

/** Seed one object straight into R2 + D1, pinned to `updatedAt`. */
async function seedFeedObject(
  key: string,
  meta: Record<string, string>,
  updatedAt: string,
  opts: { private?: boolean } = {},
) {
  await bucket.put(`alpha/${key}`, PNG, {
    httpMetadata: { contentType: "image/png" },
    ...(opts.private ? { customMetadata: { visibility: "private" } } : {}),
  });
  await replaceFileMetadata(database(sqlite), "alpha", key, meta);
  sqlite.db
    .prepare(`UPDATE file_metadata SET updated_at = ? WHERE workspace = ? AND object_key = ?`)
    .run(updatedAt, "alpha", key);
}

const shotKey = (i: number) => `gh/acme/app/pull/7/shot-${String(i).padStart(2, "0")}.png`;
const minutesBefore = (i: number) => new Date(Date.UTC(2026, 9, 1) - i * 60_000).toISOString();
const itemIdFor = async (key: string) => (await sha256Hex(key)).slice(0, 32);

/** `count` PR #7 shots; index 0 is newest. */
async function seedPr7(count: number, privateIndex?: number) {
  for (let i = 0; i < count; i++) {
    await seedFeedObject(
      shotKey(i),
      { "gh.repo": "acme/app", "gh.number": "7", "gh.kind": "pull" },
      minutesBefore(i),
      { private: i === privateIndex },
    );
  }
}

async function createPr7Feed(): Promise<string> {
  const created = await request("/v1/workspaces/alpha/feeds", {
    method: "POST",
    body: JSON.stringify({ repo: "acme/app", pr: 7 }),
  });
  expect(created.status).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

describe("public feed pagination and pager", () => {
  it("pages a public feed past 50 items with nextCursor", async () => {
    await seedPr7(55);
    const id = await createPr7Feed();

    const first = await app.request(`/public/feeds/${id}`, {}, env);
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      items: Array<{ filename: string }>;
      nextCursor: string | null;
    };
    expect(page.items).toHaveLength(50);
    expect(page.items[0]?.filename).toBe("shot-00.png");
    expect(page.nextCursor).toEqual(expect.any(String));

    const second = (await (
      await app.request(`/public/feeds/${id}?cursor=${page.nextCursor}`, {}, env)
    ).json()) as typeof page;
    expect(second.items.map((item) => item.filename)).toEqual([
      "shot-50.png",
      "shot-51.png",
      "shot-52.png",
      "shot-53.png",
      "shot-54.png",
    ]);
    expect(second.nextCursor).toBeNull();

    const bad = await app.request(`/public/feeds/${id}?cursor=not-a-cursor`, {}, env);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_cursor" } });
  });

  it("keeps object keys out of the public nextCursor when the last item is private", async () => {
    const privateKey = `gh/private/${"a1".repeat(16)}/acme/app/pull/7/secret.png`;
    for (let i = 0; i < 52; i++) {
      const key = i === 49 ? privateKey : shotKey(i);
      await seedFeedObject(
        key,
        { "gh.repo": "acme/app", "gh.number": "7", "gh.kind": "pull" },
        minutesBefore(i),
        { private: i === 49 },
      );
    }
    const id = await createPr7Feed();
    const page = (await (await app.request(`/public/feeds/${id}`, {}, env)).json()) as {
      items: Array<{ filename: string; status: string }>;
      nextCursor: string;
    };
    expect(page.items.at(-1)).toMatchObject({ filename: "secret.png", status: "withheld" });
    const decoded = Buffer.from(page.nextCursor, "base64url").toString("utf8");
    expect(decoded).not.toContain("gh/private/");
    expect(decoded).not.toContain("secret.png");
    expect(decoded).not.toContain("acme/app");
    expect(decoded).toContain(await itemIdFor(privateKey));

    const next = (await (
      await app.request(`/public/feeds/${id}?cursor=${page.nextCursor}`, {}, env)
    ).json()) as { items: Array<{ filename: string }>; nextCursor: string | null };
    expect(next.items.map((item) => item.filename)).toEqual(["shot-50.png", "shot-51.png"]);
  });

  it("pages every item exactly once across a boundary with shared updated_at values", async () => {
    // Items 49, 50, and 51 share one timestamp, so the 50-item boundary splits a tie.
    for (let i = 0; i < 55; i++) {
      await seedFeedObject(
        shotKey(i),
        { "gh.repo": "acme/app", "gh.number": "7", "gh.kind": "pull" },
        minutesBefore(i >= 49 && i <= 51 ? 49 : i),
      );
    }
    const id = await createPr7Feed();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await app.request(
        `/public/feeds/${id}${cursor ? `?cursor=${cursor}` : ""}`,
        {},
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ filename: string }>;
        nextCursor: string | null;
      };
      seen.push(...body.items.map((item) => item.filename));
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 5);
    expect(pages).toBe(2);
    expect(seen).toHaveLength(55);
    expect(new Set(seen).size).toBe(55);
    expect(new Set(seen)).toEqual(
      new Set(Array.from({ length: 55 }, (_, i) => `shot-${String(i).padStart(2, "0")}.png`)),
    );
  });

  it("resumes strictly older when the cursor's item vanished", async () => {
    await seedPr7(55);
    const id = await createPr7Feed();
    const page = (await (await app.request(`/public/feeds/${id}`, {}, env)).json()) as {
      nextCursor: string;
    };
    sqlite.db
      .prepare(`DELETE FROM file_metadata WHERE workspace = ? AND object_key = ?`)
      .run("alpha", shotKey(49));
    const next = (await (
      await app.request(`/public/feeds/${id}?cursor=${page.nextCursor}`, {}, env)
    ).json()) as { items: Array<{ filename: string }> };
    expect(next.items.map((item) => item.filename)).toEqual([
      "shot-50.png",
      "shot-51.png",
      "shot-52.png",
      "shot-53.png",
      "shot-54.png",
    ]);
  });

  it("resolves a pager item older than the newest 50 with its neighbours", async () => {
    await seedPr7(55);
    const id = await createPr7Feed();

    const res = await app.request(
      `/public/feeds/${id}/items/${await itemIdFor(shotKey(52))}`,
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublicFeedItemPage;
    expect(body).toMatchObject({
      feed: { id, title: "acme/app#7", repo: "acme/app", number: 7, kind: "pull" },
      item: { id: await itemIdFor(shotKey(52)), filename: "shot-52.png", status: "available" },
      prev: await itemIdFor(shotKey(51)),
      next: await itemIdFor(shotKey(53)),
      index: 52,
      total: 55,
    });
    expect(body.item).not.toHaveProperty("objectKey");
    expect(body.feed).not.toHaveProperty("source");

    const newest = (await (
      await app.request(`/public/feeds/${id}/items/${await itemIdFor(shotKey(0))}`, {}, env)
    ).json()) as PublicFeedItemPage;
    expect(newest).toMatchObject({ index: 0, prev: null, next: await itemIdFor(shotKey(1)) });
    const oldest = (await (
      await app.request(`/public/feeds/${id}/items/${await itemIdFor(shotKey(54))}`, {}, env)
    ).json()) as PublicFeedItemPage;
    expect(oldest).toMatchObject({ index: 54, next: null });
  });

  it("reports a repo-scope pager item's feed kind as null, like the public feed", async () => {
    await seedPr7(2);
    const created = await request("/v1/workspaces/alpha/feeds", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app" }),
    });
    const id = ((await created.json()) as { id: string }).id;
    const body = (await (
      await app.request(`/public/feeds/${id}/items/${await itemIdFor(shotKey(0))}`, {}, env)
    ).json()) as PublicFeedItemPage;
    expect(body.feed).toMatchObject({ id, number: null, kind: null });
  });

  it("withholds a private pager item and 404s unknown, malformed, and revoked ids", async () => {
    await seedPr7(3, 1);
    const id = await createPr7Feed();

    const hidden = (await (
      await app.request(`/public/feeds/${id}/items/${await itemIdFor(shotKey(1))}`, {}, env)
    ).json()) as PublicFeedItemPage;
    expect(hidden.item).toMatchObject({ status: "withheld", url: null, embedUrl: null });

    const unknown = await app.request(`/public/feeds/${id}/items/${"0".repeat(32)}`, {}, env);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: "feed_item_not_found" } });
    expect((await app.request(`/public/feeds/${id}/items/not-hex`, {}, env)).status).toBe(404);

    expect((await request(`/v1/workspaces/alpha/feeds/${id}`, { method: "DELETE" })).status).toBe(
      200,
    );
    const revoked = await app.request(
      `/public/feeds/${id}/items/${await itemIdFor(shotKey(0))}`,
      {},
      env,
    );
    expect(revoked.status).toBe(404);
  });
});

describe("public pager item index cache", () => {
  let cacheStorage: FakeCacheStorage;
  let sql: string[];

  beforeEach(() => {
    cacheStorage = new FakeCacheStorage().install();
    sql = [];
    const prepare = sqlite.prepare.bind(sqlite);
    vi.spyOn(sqlite, "prepare").mockImplementation((statement: string) => {
      sql.push(statement);
      return prepare(statement);
    });
  });

  afterEach(() => {
    FakeCacheStorage.uninstall();
    vi.restoreAllMocks();
  });

  /** Scope queries the last request ran, by kind. */
  function scopeQueries() {
    const scans = sql.filter((s) => s.includes("ORDER BY r.updated_at DESC"));
    return {
      full: scans.filter((s) => !s.includes("r.updated_at >= ?")).length,
      newer: scans.filter((s) => s.includes("r.updated_at >= ?")).length,
      verify: sql.filter((s) => s.includes("r.object_key = ? LIMIT 1")).length,
    };
  }

  async function getItem(id: string, key: string) {
    sql.length = 0;
    return app.request(`/public/feeds/${id}/items/${await itemIdFor(key)}`, {}, env);
  }

  it("serves later pager items from the cached list without rescanning the scope", async () => {
    await seedPr7(55);
    const id = await createPr7Feed();

    expect((await getItem(id, shotKey(52))).status).toBe(200);
    expect(scopeQueries()).toEqual({ full: 1, newer: 0, verify: 0 });
    const stored = [...(cacheStorage.named.get(LIVE_LINK_INDEX_CACHE_NAME)?.entries.keys() ?? [])];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toContain(id);

    const res = await getItem(id, shotKey(3));
    expect(res.status).toBe(200);
    expect(scopeQueries()).toEqual({ full: 0, newer: 0, verify: 1 });
    expect(await res.json()).toMatchObject({
      item: { id: await itemIdFor(shotKey(3)), filename: "shot-03.png", status: "available" },
      prev: await itemIdFor(shotKey(2)),
      next: await itemIdFor(shotKey(4)),
      index: 3,
      total: 55,
    });
  });

  it("404s an unknown id from the cached list with one bounded query, not a scan", async () => {
    await seedPr7(5);
    const id = await createPr7Feed();
    expect((await getItem(id, shotKey(0))).status).toBe(200);

    sql.length = 0;
    const res = await app.request(`/public/feeds/${id}/items/${"0".repeat(32)}`, {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "feed_item_not_found" } });
    expect(scopeQueries()).toEqual({ full: 0, newer: 1, verify: 0 });
  });

  it("finds an item uploaded after the list was cached", async () => {
    await seedPr7(5);
    const id = await createPr7Feed();
    expect((await getItem(id, shotKey(0))).status).toBe(200);

    const newKey = "gh/acme/app/pull/7/fresh.png";
    await seedFeedObject(
      newKey,
      { "gh.repo": "acme/app", "gh.number": "7", "gh.kind": "pull" },
      new Date(Date.UTC(2026, 9, 1) + 60_000).toISOString(),
    );
    const res = await getItem(id, newKey);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      item: { filename: "fresh.png" },
      prev: null,
      next: await itemIdFor(shotKey(0)),
      index: 0,
      total: 6,
    });
    expect(scopeQueries()).toEqual({ full: 1, newer: 1, verify: 0 });

    // The rebuilt list now answers neighbours with the new item in place.
    const next = await getItem(id, shotKey(0));
    expect(await next.json()).toMatchObject({ prev: await itemIdFor(newKey), index: 1 });
    expect(scopeQueries()).toEqual({ full: 0, newer: 0, verify: 1 });
  });

  it("never serves a cached item whose file left the scope", async () => {
    await seedPr7(5);
    const id = await createPr7Feed();
    expect((await getItem(id, shotKey(0))).status).toBe(200);

    sqlite.db
      .prepare(`DELETE FROM file_metadata WHERE workspace = ? AND object_key = ?`)
      .run("alpha", shotKey(2));
    expect((await getItem(id, shotKey(2))).status).toBe(404);

    // The rebuild dropped the deleted file from the neighbours.
    const res = await getItem(id, shotKey(3));
    expect(await res.json()).toMatchObject({
      prev: await itemIdFor(shotKey(1)),
      index: 2,
      total: 4,
    });
    expect(scopeQueries()).toEqual({ full: 0, newer: 0, verify: 1 });
  });

  it("withholds a cached item made private after the list was cached", async () => {
    await seedPr7(3);
    const id = await createPr7Feed();
    expect((await getItem(id, shotKey(0))).status).toBe(200);

    await bucket.put(`alpha/${shotKey(1)}`, PNG, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { visibility: "private" },
    });
    const res = await getItem(id, shotKey(1));
    expect(res.status).toBe(200);
    const body = (await res.json()) as PublicFeedItemPage;
    expect(body.item).toMatchObject({ status: "withheld", url: null, embedUrl: null });
    expect(JSON.stringify(body)).not.toContain(shotKey(1));
    expect(scopeQueries().full).toBe(0);
  });

  it("keeps each live link's list to itself and 404s a revoked link", async () => {
    await seedPr7(3);
    await seedFeedObject(
      "gh/acme/app/pull/8/other.png",
      { "gh.repo": "acme/app", "gh.number": "8", "gh.kind": "pull" },
      minutesBefore(0),
    );
    const pr7 = await createPr7Feed();
    const created = await request("/v1/workspaces/alpha/feeds", {
      method: "POST",
      body: JSON.stringify({ repo: "acme/app", pr: 8 }),
    });
    const pr8 = ((await created.json()) as { id: string }).id;

    expect((await getItem(pr7, shotKey(0))).status).toBe(200);
    expect((await getItem(pr8, shotKey(0))).status).toBe(404);
    expect((await getItem(pr8, "gh/acme/app/pull/8/other.png")).status).toBe(200);
    expect((await getItem(pr7, "gh/acme/app/pull/8/other.png")).status).toBe(404);

    expect((await request(`/v1/workspaces/alpha/feeds/${pr7}`, { method: "DELETE" })).status).toBe(
      200,
    );
    expect((await getItem(pr7, shotKey(0))).status).toBe(404);
  });

  it("ignores a cached list older than the TTL", async () => {
    await seedPr7(3);
    const id = await createPr7Feed();
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    expect((await getItem(id, shotKey(0))).status).toBe(200);

    now.mockReturnValue(start + (LIVE_LINK_INDEX_TTL_SECONDS + 1) * 1000);
    expect((await getItem(id, shotKey(1))).status).toBe(200);
    expect(scopeQueries()).toEqual({ full: 1, newer: 0, verify: 0 });
  });
});
