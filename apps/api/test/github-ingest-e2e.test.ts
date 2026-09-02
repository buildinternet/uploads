/**
 * End-to-end smoke test for GitHub attachment ingestion (spec
 * docs/superpowers/specs/2026-08-11-github-attachment-ingestion-design.md),
 * task 9. Exercises the REAL chain with no module mocking:
 *
 *   handleWebhook (github-webhook.ts)
 *     → enqueues a compact WebhookEvent onto GITHUB_WEBHOOK_QUEUE
 *   handleGithubWebhookBatch (github-webhook-queue.ts)
 *     → processWebhookEvent → ingestForWebhook → reconcileIngestSource
 *     → the REAL putObject (files-core.ts) writing to a fake R2 bucket
 *
 * Harness patterns are copied wholesale from github-ingest.test.ts (fake
 * GitHub App env/KV, fakeFetch route table, globalThis.fetch swap for
 * repo-comment-config's un-seamed fetch) and routes-workspace-github.test.ts
 * (REGISTRY/D1/R2 env shape for exercising real putObject).
 */
import { describe, expect, it } from "vitest";
import { attachmentKeyBasename } from "../src/github-attachment-extract";
import { findObjectsByMetadata } from "../src/file-metadata";
import { ledgerRow } from "../src/github-ingest-ledger";
import { recordRepoLink } from "../src/github-repo-links";
import { extractWebhookEvent, handleWebhook, type WebhookEvent } from "../src/github-webhook";
import { GITHUB_WEBHOOK_QUEUE, handleGithubWebhookBatch } from "../src/github-webhook-queue";
import type { WorkspaceRecord } from "../src/workspace";
import { FakeKv } from "./fake-kv";
import { FakeR2Bucket } from "./fake-r2";
import { GITHUB_APP_CFG_ENV } from "./github-app-env";
import { fakeFetch, pngRoute, withGlobalFetch } from "./helpers/github-fetch-fakes";
import { UsageFakeD1 } from "./usage-fake-d1";

const REPO = "acme/app";
const WS = "acme";
const NUM = 7;
const COMMENT_ID = 555;
const ASSET_ID = "assets/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ASSET_URL = `https://github.com/user-attachments/${ASSET_ID}`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const KEY = `gh/acme-app/pull-${NUM}/${attachmentKeyBasename(ASSET_ID)}.png`;

/** A realistic `issue_comment` `created` webhook payload on a PR thread whose
 * comment body carries a user-attachments asset URL. */
const issueCommentPayload = {
  action: "created",
  repository: { full_name: REPO, id: 123456 },
  issue: {
    number: NUM,
    pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/${NUM}` },
  },
  comment: {
    id: COMMENT_ID,
    body: `Here's a screenshot of the bug:\n\n${ASSET_URL}`,
    user: { login: "octocat", type: "User" },
  },
  sender: { login: "octocat", type: "User" },
};

/** Minimal queue producer binding stand-in (github-webhook-queue.test.ts style). */
class FakeQueue {
  sent: WebhookEvent[] = [];
  async send(body: WebhookEvent): Promise<void> {
    this.sent.push(body);
  }
}

interface FakeMessage {
  body: WebhookEvent;
  attempts: number;
  acked: boolean;
  retried: boolean;
  ack(): void;
  retry(): void;
}

function msg(body: WebhookEvent): FakeMessage {
  const m: FakeMessage = {
    body,
    attempts: 1,
    acked: false,
    retried: false,
    ack() {
      m.acked = true;
    },
    retry() {
      m.retried = true;
    },
  };
  return m;
}

function batch(messages: FakeMessage[]): MessageBatch<WebhookEvent> {
  return { queue: GITHUB_WEBHOOK_QUEUE, messages } as unknown as MessageBatch<WebhookEvent>;
}

describe("github ingest end-to-end (webhook → queue → real putObject)", () => {
  it("issue_comment created enqueues a compact ingest event with the expected shape", async () => {
    const kv = new FakeKv();
    const queue = new FakeQueue();
    const env = { GITHUB_CACHE: kv, GITHUB_WEBHOOK_QUEUE: queue } as unknown as Env;

    await handleWebhook(env, "issue_comment", issueCommentPayload);

    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]!.ingest).toEqual({
      repo: REPO,
      kind: "pull",
      num: NUM,
      source: `comment:${COMMENT_ID}`,
    });
  });

  it("feeds the enqueued message through the real queue consumer: acks, writes the real object, stamps metadata + ledger", async () => {
    // 1. Produce the compact event exactly as the webhook route would.
    const ev = extractWebhookEvent("issue_comment", issueCommentPayload);
    expect(ev?.ingest).toEqual({
      repo: REPO,
      kind: "pull",
      num: NUM,
      source: `comment:${COMMENT_ID}`,
    });

    // 2. Build a real-module processing env: D1 fakes, GITHUB_CACHE KV, a
    // REGISTRY-backed workspace with the opt-in knob on, and a real R2 fake
    // so the real putObject writes somewhere. No GITHUB_WEBHOOK_QUEUE
    // binding — its absence is what makes handleGithubWebhookBatch's
    // per-message processing run for real.
    const db = new UsageFakeD1();
    const githubCache = new FakeKv();
    githubCache.store.set("ghinst:acme/app", { value: "42" });
    githubCache.store.set("ghtok:42", { value: "ghs_test" });

    const record: WorkspaceRecord = {
      provider: "r2",
      bucket: "b",
      binding: "UPLOADS_DEFAULT",
      prefix: "acme/",
      publicBaseUrl: "https://storage.uploads.sh",
      githubIngestAttachments: true,
    };
    const registry = {
      get: (async (key: string) =>
        key === `ws:${WS}` ? record : null) as unknown as KVNamespace["get"],
    };

    const env = {
      DB: db,
      GITHUB_CACHE: githubCache,
      REGISTRY: registry,
      UPLOADS_DEFAULT: new FakeR2Bucket(),
      ...GITHUB_APP_CFG_ENV,
    } as unknown as Env;

    await recordRepoLink(env.DB, REPO, WS, "test");

    // 3. Fake every GitHub API call the chain makes: repo-comment-config's
    // un-seamed contents lookup (404 → no repo config, workspace default
    // wins), the comment GET (returns the same body), and the asset URL
    // itself (PNG bytes).
    const fetchImpl = fakeFetch({
      "/contents/": () => new Response("nf", { status: 404 }),
      [`/issues/comments/${COMMENT_ID}`]: () =>
        new Response(
          JSON.stringify({ body: issueCommentPayload.comment.body, user: { login: "octocat" } }),
          { status: 200 },
        ),
      [ASSET_ID]: pngRoute(PNG),
    });

    const message = msg(ev!);
    await withGlobalFetch(fetchImpl, () => handleGithubWebhookBatch(batch([message]), env));

    // Message acked (not retried).
    expect(message.acked).toBe(true);
    expect(message.retried).toBe(false);

    // Object exists in the fake R2 under the expected key.
    const bucket = env.UPLOADS_DEFAULT as unknown as FakeR2Bucket;
    const stored = bucket.store.get(`acme/${KEY}`) ?? bucket.store.get(KEY);
    expect(stored).toBeDefined();

    // findObjectsByMetadata returns exactly that key.
    const found = await findObjectsByMetadata(env.DB, WS, {
      "gh.origin": "github",
      "gh.detached": "false",
    });
    expect(found.map((f) => f.key)).toEqual([KEY]);

    // Ledger row exists and is not detached.
    const row = await ledgerRow(env.DB, REPO, ASSET_ID);
    expect(row).not.toBeNull();
    expect(row?.detachedAt).toBeNull();
    expect(row?.objectKey).toBe(KEY);
  });

  it("ingested assets get NO attachment index row (issue #934)", async () => {
    // Reuse this file's existing happy-path ingest setup verbatim, through
    // the call that stores at least one asset.
    const ev = extractWebhookEvent("issue_comment", issueCommentPayload);
    expect(ev?.ingest).toEqual({
      repo: REPO,
      kind: "pull",
      num: NUM,
      source: `comment:${COMMENT_ID}`,
    });

    const db = new UsageFakeD1();
    const githubCache = new FakeKv();
    githubCache.store.set("ghinst:acme/app", { value: "42" });
    githubCache.store.set("ghtok:42", { value: "ghs_test" });

    const record: WorkspaceRecord = {
      provider: "r2",
      bucket: "b",
      binding: "UPLOADS_DEFAULT",
      prefix: "acme/",
      publicBaseUrl: "https://storage.uploads.sh",
      githubIngestAttachments: true,
    };
    const registry = {
      get: (async (key: string) =>
        key === `ws:${WS}` ? record : null) as unknown as KVNamespace["get"],
    };

    const env = {
      DB: db,
      GITHUB_CACHE: githubCache,
      REGISTRY: registry,
      UPLOADS_DEFAULT: new FakeR2Bucket(),
      ...GITHUB_APP_CFG_ENV,
    } as unknown as Env;

    await recordRepoLink(env.DB, REPO, WS, "test");

    const fetchImpl = fakeFetch({
      "/contents/": () => new Response("nf", { status: 404 }),
      [`/issues/comments/${COMMENT_ID}`]: () =>
        new Response(
          JSON.stringify({ body: issueCommentPayload.comment.body, user: { login: "octocat" } }),
          { status: 200 },
        ),
      [ASSET_ID]: pngRoute(PNG),
    });

    const message = msg(ev!);
    await withGlobalFetch(fetchImpl, () => handleGithubWebhookBatch(batch([message]), env));

    expect(message.acked).toBe(true);

    // Ingest keys (`gh/<owner>-<name>/<kind>-<num>/…` and
    // `gh/private/<id>/ingest/…`) deliberately live outside the comment's
    // attachment prefix — they are an index only, never rendered — so
    // parseAttachmentKey returns undefined and putObject writes no row.
    expect(db.ingestLedger.size).toBeGreaterThan(0);
    expect(db.attachmentIndex.size).toBe(0);
  });
});
