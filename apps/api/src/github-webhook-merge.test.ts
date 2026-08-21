/**
 * Persisted PR merge-state tagging (`pull_request` `closed` handling in
 * github-webhook.ts): a real merge stamps `gh.merged=true` on the PR's
 * screenshots; a close-without-merge, an unbound repo, and a fork PR are all
 * no-ops. Same `handleWebhook`-direct-call shape as
 * github-webhook-auto-promote.test.ts, so every assertion below is
 * deterministic without draining a `waitUntil` queue.
 */
import { describe, expect, it } from "vitest";
import { handleWebhook } from "./github-webhook";
import { getFileMetadata, replaceFileMetadata } from "./file-metadata";
import { recordRepoLink } from "./github-repo-links";
import { sha256Hex, type WorkspaceRecord } from "./workspace";
import { FakeKv } from "../test/fake-kv";
import { FakeR2Bucket } from "../test/fake-r2";
import { UsageFakeD1 } from "../test/usage-fake-d1";
import { GITHUB_APP_CFG_ENV } from "../test/github-app-env";

const WS = "acme";
const PREFIX = "acme/";
const REPO = "acme/web";
const NUM = 12;
const REF = "acme/web#12";

function shotKey(filename: string): string {
  return `gh/acme/web/pull/${NUM}/${filename}`;
}

async function baseEnv(): Promise<{ env: Env; db: UsageFakeD1; bucket: FakeR2Bucket }> {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "b",
    binding: "UPLOADS_DEFAULT",
    prefix: PREFIX,
    publicBaseUrl: "https://storage.uploads.sh",
    tokens: [{ hash: await sha256Hex("unused"), createdAt: new Date().toISOString() }],
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
  return { env, db, bucket };
}

/** Seed one already-promoted PR screenshot, tagged like `promoteBranchAttachments` leaves it. */
async function seedPrShot(env: Env, filename: string, extra: Record<string, string> = {}) {
  const key = shotKey(filename);
  await replaceFileMetadata(env.DB, WS, key, {
    "gh.repo": REPO,
    "gh.kind": "pull",
    "gh.number": String(NUM),
    "gh.ref": REF,
    ...extra,
  });
  return key;
}

function closedPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "closed",
    repository: { full_name: REPO },
    pull_request: {
      number: NUM,
      merged: true,
      head: { ref: "feat-x", repo: { full_name: REPO } },
    },
    ...overrides,
  };
}

describe("handleWebhook pull_request closed merge-tagging", () => {
  it("stamps gh.merged=true on the PR's screenshots when merged: true", async () => {
    const { env } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");
    const keyA = await seedPrShot(env, "hero.png");
    const keyB = await seedPrShot(env, "footer.png");

    await handleWebhook(env, "pull_request", closedPayload());

    expect((await getFileMetadata(env.DB, WS, keyA))["gh.merged"]).toBe("true");
    expect((await getFileMetadata(env.DB, WS, keyB))["gh.merged"]).toBe("true");
  });

  it("does not disturb existing gh.* tags (merge write)", async () => {
    const { env } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");
    const key = await seedPrShot(env, "hero.png", { "gh.promoted-at": "2026-08-01T00:00:00.000Z" });

    await handleWebhook(env, "pull_request", closedPayload());

    const meta = await getFileMetadata(env.DB, WS, key);
    expect(meta["gh.merged"]).toBe("true");
    expect(meta["gh.promoted-at"]).toBe("2026-08-01T00:00:00.000Z");
    expect(meta["gh.repo"]).toBe(REPO);
  });

  it("finds shots by metadata, not key prefix, so private-prefix keys are stamped too", async () => {
    const { env } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");
    // A key that does NOT match the plain gh/<owner>/<repo>/pull/<n>/ shape —
    // stands in for a private-repo gh/private/<hex>/... key. Findable only
    // because the lookup below is metadata-driven (gh.ref + gh.kind).
    const key = "gh/private/deadbeefdeadbeefdeadbeefdeadbeef/pull/12/hero.png";
    await replaceFileMetadata(env.DB, WS, key, {
      "gh.repo": REPO,
      "gh.kind": "pull",
      "gh.number": String(NUM),
      "gh.ref": REF,
    });

    await handleWebhook(env, "pull_request", closedPayload());

    expect((await getFileMetadata(env.DB, WS, key))["gh.merged"]).toBe("true");
  });

  it("does nothing when closed without merging (merged: false)", async () => {
    const { env } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");
    const key = await seedPrShot(env, "hero.png");

    await handleWebhook(
      env,
      "pull_request",
      closedPayload({
        pull_request: {
          number: NUM,
          merged: false,
          head: { ref: "feat-x", repo: { full_name: REPO } },
        },
      }),
    );

    expect((await getFileMetadata(env.DB, WS, key))["gh.merged"]).toBeUndefined();
  });

  it("does nothing when merged is absent entirely", async () => {
    const { env } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");
    const key = await seedPrShot(env, "hero.png");

    await handleWebhook(
      env,
      "pull_request",
      closedPayload({
        pull_request: { number: NUM, head: { ref: "feat-x", repo: { full_name: REPO } } },
      }),
    );

    expect((await getFileMetadata(env.DB, WS, key))["gh.merged"]).toBeUndefined();
  });

  it("no-ops when the repo has no binding", async () => {
    const { env } = await baseEnv();
    const key = await seedPrShot(env, "hero.png");

    await handleWebhook(env, "pull_request", closedPayload());

    // No binding was ever recorded, so the shot was seeded straight into D1
    // with WS as its workspace — nothing should touch it.
    expect((await getFileMetadata(env.DB, WS, key))["gh.merged"]).toBeUndefined();
  });

  it("applies the same fork guard as promote: a fork PR's merge is not tagged", async () => {
    const { env } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");
    const key = await seedPrShot(env, "hero.png");

    await handleWebhook(
      env,
      "pull_request",
      closedPayload({
        pull_request: {
          number: NUM,
          merged: true,
          head: { ref: "feat-x", repo: { full_name: "someone-else/fork" } },
        },
      }),
    );

    expect((await getFileMetadata(env.DB, WS, key))["gh.merged"]).toBeUndefined();
  });

  it("cleans up the link and no-ops when the bound workspace is gone", async () => {
    const { env, db } = await baseEnv();
    await recordRepoLink(env.DB, REPO, "ghost-workspace", "promote");

    await handleWebhook(env, "pull_request", closedPayload());

    expect(db.repoLinks.has(REPO)).toBe(false);
  });

  it("logs and never throws when a per-shot metadata write fails (best-effort tagging)", async () => {
    const { env, db } = await baseEnv();
    await recordRepoLink(env.DB, REPO, WS, "promote");
    await seedPrShot(env, "hero.png");

    const realBatch = db.batch.bind(db);
    db.batch = (() => {
      throw new Error("boom");
    }) as typeof db.batch;
    try {
      await expect(handleWebhook(env, "pull_request", closedPayload())).resolves.toBeUndefined();
    } finally {
      db.batch = realBatch;
    }
  });
});
