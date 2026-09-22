/// <reference types="node" />

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";
import { FakeR2Bucket } from "./fake-r2";
import { SqliteD1 } from "./helpers/sqlite-d1";

const TOKEN = "feed-token";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const MIGRATIONS = [
  "migrations/20260710120000_auth.sql",
  "migrations/20260710140000_workspace_usage.sql",
  "migrations/20260822120100_workspace_usage_shared_subset.sql",
  "migrations/20260712230000_token_minting_user.sql",
  "migrations/20260817180000_token_last_used.sql",
  "migrations/20260713210559_file_metadata.sql",
  "migrations/20260915120000_feeds.sql",
  "migrations/20260915153000_feeds_number.sql",
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
    expect(body.items.map((item) => item.filename)).toEqual(["one.png"]);
    expect(body.items[0]).not.toHaveProperty("objectKey");
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
  });
});
