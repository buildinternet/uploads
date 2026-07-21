import { describe, expect, it } from "vitest";
import { app } from "../index";
import { getFileMetadata, replaceFileMetadata } from "../file-metadata";
import { sha256Hex, type WorkspaceRecord } from "../workspace";
import { FakeR2Bucket } from "../../test/fake-r2";
import { FakeKv } from "../../test/fake-kv";
import { UsageFakeD1 } from "../../test/usage-fake-d1";
import { GITHUB_APP_CFG_ENV } from "../../test/github-app-env";

// Same node-vs-workerd Web Crypto gap as github-comment-route.test.ts — this
// suite exercises the real workspaceAuth middleware end to end.
if (typeof crypto.subtle.timingSafeEqual !== "function") {
  (
    crypto.subtle as unknown as { timingSafeEqual: (a: Uint8Array, b: Uint8Array) => boolean }
  ).timingSafeEqual = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);
}

const WS = "acme";
const TOKEN = "up_acme_testtoken";
const PREFIX = "acme/";
const REPO = "acme/web";
const BRANCH = "feat-x";
const NUM = 12;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function stagedKey(filename: string): string {
  return `gh/acme/web/branch/${BRANCH}/${filename}`;
}

function destKey(filename: string): string {
  return `gh/acme/web/pull/${NUM}/${filename}`;
}

interface Seeded {
  env: Env;
  db: UsageFakeD1;
  bucket: FakeR2Bucket;
}

async function seededEnv(
  opts: {
    scopedToken?: { rawToken: string; scopes: string[] };
    /**
     * Wires the calling token to a Better Auth minting user id (issue #297's
     * claim-authorization gate reads this via `c.get("mintingUserId")`), plus
     * GitHub App config/cache so `isEntitledToClaimRepo` can resolve an
     * installation. Callers still need to preseed `ghlogin:<mintingUserId>`
     * in the returned GITHUB_CACHE (or mock the AUTH-lookup fetch) and mock
     * the collaborator-permission fetch to actually grant entitlement.
     */
    mintingUserId?: string;
  } = {},
): Promise<Seeded> {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "b",
    binding: "UPLOADS_DEFAULT",
    prefix: PREFIX,
    publicBaseUrl: "https://storage.uploads.sh",
    tokens: [{ hash: await sha256Hex(TOKEN), createdAt: new Date().toISOString() }],
  };
  const registry = {
    get: (async (key: string) =>
      key === `ws:${WS}` ? record : null) as unknown as KVNamespace["get"],
  };
  const bucket = new FakeR2Bucket();
  const db = new UsageFakeD1();
  const githubCache = new FakeKv();

  const env = {
    REGISTRY: registry,
    DB: db,
    UPLOADS_DEFAULT: bucket,
    GITHUB_CACHE: githubCache,
    ...GITHUB_APP_CFG_ENV,
  } as unknown as Env;

  if (opts.mintingUserId) {
    // Layer a D1-backed token carrying a minting user id on top of the
    // fake's auth_tokens no-op — same shape `workspaceAuth` reads via
    // `findActiveToken`/`d1Token.minting_user_id` (workspace.ts).
    const hash = await sha256Hex(TOKEN);
    const mintingUserId = opts.mintingUserId;
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT id, workspace, token_hash")) {
        let args: unknown[] = [];
        return {
          bind: (...v: unknown[]) => {
            args = v;
            return {
              first: async () => {
                const tokHash = args[1] as string;
                if (tokHash !== hash) return null;
                return {
                  id: "token-id",
                  workspace: WS,
                  token_hash: hash,
                  label: null,
                  scopes: JSON.stringify(["files:read", "files:write", "files:delete"]),
                  created_at: "2026-07-13T00:00:00.000Z",
                  expires_at: null,
                  revoked_at: null,
                  minting_user_id: mintingUserId,
                };
              },
              all: async () => ({ results: [] }),
              run: async () => ({}),
            };
          },
        };
      }
      return originalPrepare(sql);
    }) as typeof db.prepare;
  }

  if (opts.scopedToken) {
    // Layer a D1-backed scoped token on top of the fake's auth_tokens no-op,
    // so requireScope has something less than the legacy path's full grant
    // to reject.
    const scopedHash = await sha256Hex(opts.scopedToken.rawToken);
    const scopes = JSON.stringify(opts.scopedToken.scopes);
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("SELECT id, workspace, token_hash")) {
        let args: unknown[] = [];
        return {
          bind: (...v: unknown[]) => {
            args = v;
            return {
              first: async () => {
                const hash = args[1] as string;
                if (hash !== scopedHash) return null;
                return {
                  id: "token-id",
                  workspace: WS,
                  token_hash: scopedHash,
                  label: null,
                  scopes,
                  created_at: "2026-07-13T00:00:00.000Z",
                  expires_at: null,
                  revoked_at: null,
                  minting_user_id: null,
                };
              },
              all: async () => ({ results: [] }),
              run: async () => ({}),
            };
          },
        };
      }
      return originalPrepare(sql);
    }) as typeof db.prepare;
  }

  return { env, db, bucket };
}

/** Seed a staged R2 object plus its D1 gh.* branch metadata. */
async function seedStaged(
  seeded: Seeded,
  filename: string,
  opts: {
    stagedAt?: string | null; // null = omit entirely
    visibility?: "private";
    provenance?: Record<string, string>;
    bytes?: Uint8Array;
    uploader?: string; // gh.uploader login; also sets gh.uploader-id=user-1
  } = {},
) {
  const bytes = opts.bytes ?? PNG;
  await seeded.bucket.put(`${PREFIX}${stagedKey(filename)}`, bytes, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: {
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
      ...opts.provenance,
    },
  });
  const stagedAt = opts.stagedAt === null ? undefined : (opts.stagedAt ?? new Date().toISOString());
  await replaceFileMetadata(seeded.env.DB, WS, stagedKey(filename), {
    "gh.repo": "acme/web",
    "gh.kind": "branch",
    "gh.branch": BRANCH,
    ...(stagedAt ? { "gh.staged-at": stagedAt } : {}),
    ...(opts.uploader ? { "gh.uploader": opts.uploader, "gh.uploader-id": "user-1" } : {}),
  });
}

function post(env: Env, body: unknown, token: string = TOKEN) {
  return app.request(
    `/v1/${WS}/github/promote`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("POST /v1/:workspace/github/promote", () => {
  it("400s on a malformed body", async () => {
    const { env } = await seededEnv();
    const res = await post(env, { repo: "not-a-repo", num: 0, branch: "" });
    expect(res.status).toBe(400);
  });

  it("400s on a dot-only repo segment", async () => {
    const { env } = await seededEnv();
    const res = await post(env, { repo: "../etc", num: 12, branch: "feat" });
    expect(res.status).toBe(400);
  });

  it("400s on a non-positive num", async () => {
    const { env } = await seededEnv();
    const res = await post(env, { repo: REPO, num: 0, branch: "feat" });
    expect(res.status).toBe(400);
  });

  it("400s on an empty branch", async () => {
    const { env } = await seededEnv();
    const res = await post(env, { repo: REPO, num: 12, branch: "" });
    expect(res.status).toBe(400);
  });

  it("401s with no bearer token", async () => {
    const { env } = await seededEnv();
    const res = await app.request(
      `/v1/${WS}/github/promote`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: REPO, num: NUM, branch: BRANCH }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("403s a files:read-only scoped token", async () => {
    const scopedToken = "up_acme_readonly";
    const { env } = await seededEnv({
      scopedToken: { rawToken: scopedToken, scopes: ["files:read"] },
    });
    const res = await post(env, { repo: REPO, num: NUM, branch: BRANCH }, scopedToken);
    expect(res.status).toBe(403);
  });

  it("is a success with empty arrays when the staging prefix is empty", async () => {
    const { env } = await seededEnv();
    const res = await post(env, { repo: REPO, num: NUM, branch: BRANCH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ promoted: [], skipped: [] });
  });

  it("promotes a fresh staged file and tags both copy and original", async () => {
    const seeded = await seededEnv();
    await seedStaged(seeded, "hero.png");

    const res = await post(seeded.env, { repo: REPO, num: NUM, branch: BRANCH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { promoted: string[]; skipped: unknown[] };
    expect(body.promoted).toEqual([destKey("hero.png")]);
    expect(body.skipped).toEqual([]);

    // Destination object landed in R2 under the workspace's prefix.
    const stored = seeded.bucket.store.get(`${PREFIX}${destKey("hero.png")}`);
    expect(stored).toBeDefined();
    expect(stored?.contentType).toBe("image/png");
    expect([...(stored?.data ?? [])]).toEqual([...PNG]);

    // Copy's D1 metadata is a full, self-contained gh.* set.
    const copyMeta = await getFileMetadata(seeded.env.DB, WS, destKey("hero.png"));
    expect(copyMeta["gh.repo"]).toBe("acme/web");
    expect(copyMeta["gh.kind"]).toBe("pull");
    expect(copyMeta["gh.number"]).toBe("12");
    expect(copyMeta["gh.ref"]).toBe("acme/web#12");
    expect(copyMeta["gh.branch"]).toBe(BRANCH);
    expect(typeof copyMeta["gh.promoted-at"]).toBe("string");

    // Original is merge-tagged, not replaced — its staged tags survive.
    const originalMeta = await getFileMetadata(seeded.env.DB, WS, stagedKey("hero.png"));
    expect(originalMeta["gh.kind"]).toBe("branch");
    expect(originalMeta["gh.branch"]).toBe(BRANCH);
    expect(originalMeta["gh.promoted-to"]).toBe("acme/web#12");
    expect(typeof originalMeta["gh.promoted-at"]).toBe("string");
    // Lifecycle flip (issue #339): the staged original is no longer
    // "in flight" once promoted.
    expect(originalMeta["gh.status"]).toBe("promoted");

    // Promotion also upserts the PR activity rollup (issue #338) via
    // putObject's gh.kind=pull metadata hook.
    expect(seeded.db.prActivity.get("acme/web#12")).toMatchObject({
      repo_full_name: "acme/web",
      pr_number: NUM,
      branch: BRANCH,
      workspace_name: WS,
      media_count: 1,
    });
  });

  it("treats a missing gh.staged-at as fresh (workspace's own data)", async () => {
    const seeded = await seededEnv();
    await seedStaged(seeded, "hero.png", { stagedAt: null });

    const res = await post(seeded.env, { repo: REPO, num: NUM, branch: BRANCH });
    const body = (await res.json()) as { promoted: string[]; skipped: unknown[] };
    expect(body.promoted).toEqual([destKey("hero.png")]);
    expect(body.skipped).toEqual([]);
  });

  it("skips a staged file older than the 30-day freshness window", async () => {
    const seeded = await seededEnv();
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    await seedStaged(seeded, "stale.png", { stagedAt: old });

    const res = await post(seeded.env, { repo: REPO, num: NUM, branch: BRANCH });
    const body = (await res.json()) as {
      promoted: string[];
      skipped: { key: string; reason: string }[];
    };
    expect(body.promoted).toEqual([]);
    expect(body.skipped).toEqual([{ key: stagedKey("stale.png"), reason: "stale" }]);
  });

  it("preserves visibility and provenance custom metadata on the copy", async () => {
    const seeded = await seededEnv();
    await seedStaged(seeded, "private.png", {
      visibility: "private",
      provenance: { client: "uploads-cli", "client-version": "1.2.3" },
    });

    const res = await post(seeded.env, { repo: REPO, num: NUM, branch: BRANCH });
    const body = (await res.json()) as { promoted: string[] };
    expect(body.promoted).toEqual([destKey("private.png")]);

    const stored = seeded.bucket.store.get(`${PREFIX}${destKey("private.png")}`);
    expect(stored?.customMetadata?.visibility).toBe("private");
    expect(stored?.customMetadata?.client).toBe("uploads-cli");
    expect(stored?.customMetadata?.["client-version"]).toBe("1.2.3");
  });

  it("is idempotent: re-promoting overwrites the destination copy", async () => {
    const seeded = await seededEnv();
    await seedStaged(seeded, "hero.png");

    const first = await post(seeded.env, { repo: REPO, num: NUM, branch: BRANCH });
    expect(first.status).toBe(200);
    const second = await post(seeded.env, { repo: REPO, num: NUM, branch: BRANCH });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { promoted: string[]; skipped: unknown[] };
    expect(body.promoted).toEqual([destKey("hero.png")]);
    expect(body.skipped).toEqual([]);
    // Still exactly one destination object, not a duplicate.
    expect(seeded.bucket.store.has(`${PREFIX}${destKey("hero.png")}`)).toBe(true);
  });

  it("caps at 50 staged files, reporting the overflow as skipped", async () => {
    const seeded = await seededEnv();
    for (let i = 0; i < 51; i++) {
      await seedStaged(seeded, `f${String(i).padStart(3, "0")}.png`);
    }

    const res = await post(seeded.env, { repo: REPO, num: NUM, branch: BRANCH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      promoted: string[];
      skipped: { key: string; reason: string }[];
    };
    expect(body.promoted.length).toBe(50);
    const overflow = body.skipped.filter((s) => s.reason === "cap_exceeded");
    expect(overflow.length).toBe(1);
  });

  it("degrades a single-file copy failure to a skip instead of failing the request", async () => {
    const seeded = await seededEnv();
    await seedStaged(seeded, "good.png");
    // Stage a second D1-metadata row with no backing R2 object — download()
    // returning null/throwing simulates a read-time failure for that one key.
    await replaceFileMetadata(seeded.env.DB, WS, stagedKey("ghost.png"), {
      "gh.repo": "acme/web",
      "gh.kind": "branch",
      "gh.branch": BRANCH,
      "gh.staged-at": new Date().toISOString(),
    });
    // Fake R2's list() only returns what's actually stored, so "ghost.png"
    // won't be listed unless it has an object — instead simulate a broken
    // read on an existing object by corrupting bucket.get for that key.
    await seeded.bucket.put(`${PREFIX}${stagedKey("ghost.png")}`, PNG, {
      httpMetadata: { contentType: "image/png" },
    });
    const realGet = seeded.bucket.get.bind(seeded.bucket);
    seeded.bucket.get = (async (key: string) => {
      if (key === `${PREFIX}${stagedKey("ghost.png")}`) throw new Error("boom");
      return realGet(key);
    }) as typeof seeded.bucket.get;

    const res = await post(seeded.env, { repo: REPO, num: NUM, branch: BRANCH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      promoted: string[];
      skipped: { key: string; reason: string }[];
    };
    expect(body.promoted).toEqual([destKey("good.png")]);
    // Generic reason only — no internal error detail ("boom") leaks to the caller.
    expect(body.skipped).toEqual([{ key: stagedKey("ghost.png"), reason: "copy_failed" }]);
  });

  it("still counts a file as promoted when tagging the staged original fails", async () => {
    const seeded = await seededEnv();
    await seedStaged(seeded, "hero.png");
    const originalKey = stagedKey("hero.png");

    // Make the D1 write that tags the *staged original* (gh.promoted-to /
    // gh.promoted-at, keyed by originalKey) fail, while everything targeting
    // the destination copy (destKey) succeeds normally.
    const originalPrepare = seeded.db.prepare.bind(seeded.db);
    seeded.db.prepare = ((sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (!normalized.startsWith("INSERT INTO file_metadata")) return originalPrepare(sql);
      return {
        bind: (...args: unknown[]) => {
          if (args[1] === originalKey) {
            return { run: async () => Promise.reject(new Error("boom")) };
          }
          return originalPrepare(sql).bind(...args);
        },
      };
    }) as typeof seeded.db.prepare;

    const res = await post(seeded.env, { repo: REPO, num: NUM, branch: BRANCH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { promoted: string[]; skipped: unknown[] };
    // The copy landed — it must count as promoted, not be dropped into skipped.
    expect(body.promoted).toEqual([destKey("hero.png")]);
    expect(body.skipped).toEqual([]);

    // Destination object is real.
    expect(seeded.bucket.store.has(`${PREFIX}${destKey("hero.png")}`)).toBe(true);
  });

  it("records an implicit repo-link claim when the caller is verified entitled to the repo", async () => {
    const seeded = await seededEnv({ mintingUserId: "user-1" });
    (seeded.env as unknown as { GITHUB_CACHE: FakeKv }).GITHUB_CACHE.store.set("ghinst:acme/web", {
      value: "42",
    });
    (seeded.env as unknown as { GITHUB_CACHE: FakeKv }).GITHUB_CACHE.store.set("ghtok:42", {
      value: "cached-token",
    });
    (seeded.env as unknown as { GITHUB_CACHE: FakeKv }).GITHUB_CACHE.store.set("ghlogin:user-1", {
      value: "octocat",
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) =>
      String(url).includes("/collaborators/octocat/permission")
        ? new Response(JSON.stringify({ permission: "write" }), { status: 200 })
        : new Response("nf", { status: 404 })) as unknown as typeof fetch;
    try {
      const res = await post(seeded.env, { repo: REPO, num: NUM, branch: BRANCH });
      expect(res.status).toBe(200);
      const link = seeded.db.repoLinks.get("acme/web");
      expect(link).toMatchObject({ workspace_name: WS, source: "promote" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not record a claim when the caller can't be verified entitled to an unbound repo", async () => {
    // No mintingUserId — a legacy/shared token (e.g. the communal `default`
    // workspace) can't be tied to a GitHub identity, so it must never claim a
    // NEW repo. The promote operation itself (copying the workspace's own
    // staged data) still succeeds — only the claim side effect is withheld.
    const seeded = await seededEnv();
    const res = await post(seeded.env, { repo: REPO, num: NUM, branch: BRANCH });
    expect(res.status).toBe(200);
    expect(seeded.db.repoLinks.has("acme/web")).toBe(false);
  });

  it("re-records (no-ops) an already-bound repo without an entitlement check", async () => {
    const seeded = await seededEnv();
    seeded.db.repoLinks.set("acme/web", {
      repo_full_name: "acme/web",
      workspace_name: WS,
      installation_id: null,
      source: "comment",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const res = await post(seeded.env, { repo: REPO, num: NUM, branch: BRANCH });
    expect(res.status).toBe(200);
    expect(seeded.db.repoLinks.get("acme/web")?.workspace_name).toBe(WS);
  });

  it("first-claim-wins: a second workspace's promote never overwrites an existing link", async () => {
    const seeded = await seededEnv();
    seeded.db.repoLinks.set("acme/web", {
      repo_full_name: "acme/web",
      workspace_name: "someone-else",
      installation_id: null,
      source: "comment",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const res = await post(seeded.env, { repo: REPO, num: NUM, branch: BRANCH });
    expect(res.status).toBe(200);
    expect(seeded.db.repoLinks.get("acme/web")?.workspace_name).toBe("someone-else");
  });

  it("does not record a link on a validation failure", async () => {
    const seeded = await seededEnv();
    const res = await post(seeded.env, { repo: "not-a-repo", num: 0, branch: "" });
    expect(res.status).toBe(400);
    expect(seeded.db.repoLinks.has("acme/web")).toBe(false);
  });
});

describe("uploader attribution through promotion (issue #340)", () => {
  it("the promoted copy inherits gh.uploader/gh.uploader-id from the staged original", async () => {
    const seeded = await seededEnv();
    await seedStaged(seeded, "hero.png", { uploader: "octocat" });

    const res = await post(seeded.env, { repo: REPO, num: NUM, branch: BRANCH });
    expect(res.status).toBe(200);

    const copyMeta = await getFileMetadata(seeded.env.DB, WS, destKey("hero.png"));
    expect(copyMeta["gh.uploader"]).toBe("octocat");
    expect(copyMeta["gh.uploader-id"]).toBe("user-1");
    // The rest of the copy's tag set is unchanged by inheritance.
    expect(copyMeta["gh.kind"]).toBe("pull");
    expect(copyMeta["gh.ref"]).toBe("acme/web#12");
  });

  it("a staged original without uploader tags promotes with none (no empty values)", async () => {
    const seeded = await seededEnv();
    await seedStaged(seeded, "hero.png");

    const res = await post(seeded.env, { repo: REPO, num: NUM, branch: BRANCH });
    expect(res.status).toBe(200);

    const copyMeta = await getFileMetadata(seeded.env.DB, WS, destKey("hero.png"));
    expect(copyMeta["gh.uploader"]).toBeUndefined();
    expect(copyMeta["gh.uploader-id"]).toBeUndefined();
  });
});
