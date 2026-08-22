/**
 * Queue-path ingestion for GitHub webhooks (issue #287): producer behavior in
 * `handleWebhook` (enqueue the compact event, inline fallback on a missing
 * binding or a failed send) and the consumer in github-webhook-queue.ts
 * (process/ack, retry-on-failure, DLQ log-and-ack). The extraction and
 * processing semantics themselves are covered by github-webhook.test.ts and
 * the auto-promote/reconcile suites, which exercise the queueless inline path.
 */
import { describe, expect, it, vi } from "vitest";
import { extractWebhookEvent, handleWebhook, type WebhookEvent } from "./github-webhook";
import {
  GITHUB_WEBHOOK_DLQ,
  GITHUB_WEBHOOK_QUEUE,
  handleGithubWebhookBatch,
} from "./github-webhook-queue";
import { ingestForWebhook } from "./github-ingest";
import { adoptLinkedFilesForWebhook } from "./github-link-adopt";
import { FakeKv } from "../test/fake-kv";

vi.mock("./github-ingest", () => ({ ingestForWebhook: vi.fn() }));
vi.mock("./github-link-adopt", () => ({
  adoptLinkedFilesForWebhook: vi.fn(),
  hasLinkCandidate: (text: string) => /https?:\/\//i.test(text),
}));

class FakeQueue {
  sent: WebhookEvent[] = [];
  fail = false;
  async send(body: WebhookEvent): Promise<void> {
    if (this.fail) throw new Error("queue down");
    this.sent.push(body);
  }
}

function envWith(kv: FakeKv, queue?: FakeQueue): Env {
  return { GITHUB_CACHE: kv, GITHUB_WEBHOOK_QUEUE: queue } as unknown as Env;
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

function batch(queue: string, messages: FakeMessage[]): MessageBatch<WebhookEvent> {
  return { queue, messages } as unknown as MessageBatch<WebhookEvent>;
}

describe("extractWebhookEvent", () => {
  it("returns null when a delivery implies no work", () => {
    expect(extractWebhookEvent("ping", {})).toBeNull();
    expect(extractWebhookEvent("issues", null)).toBeNull();
    expect(extractWebhookEvent("star", { repository: { full_name: "o/r" } })).toBeNull();
    // Ungated issue_comment (ordinary human comment) — the common case.
    expect(
      extractWebhookEvent("issue_comment", {
        action: "created",
        repository: { full_name: "o/r" },
        issue: { number: 1 },
        comment: { body: "nice" },
      }),
    ).toBeNull();
  });

  it("extracts a compact promote event for a same-repo PR open", () => {
    const ev = extractWebhookEvent("pull_request", {
      action: "opened",
      repository: { full_name: "Acme/Web" },
      pull_request: { number: 7, head: { ref: "feat", repo: { full_name: "acme/web" } } },
    });
    expect(ev).toEqual({
      keys: ["ghref:acme/web#7"],
      promote: { repo: "Acme/Web", num: 7, branch: "feat" },
    });
  });

  it("keeps the ref invalidation but drops promote for a fork-head PR", () => {
    const ev = extractWebhookEvent("pull_request", {
      action: "opened",
      repository: { full_name: "acme/web" },
      pull_request: { number: 7, head: { ref: "feat", repo: { full_name: "fork/web" } } },
    });
    expect(ev).toEqual({ keys: ["ghref:acme/web#7"] });
  });

  const URL = "https://github.com/user-attachments/assets/0a1b2c3d-1111-2222-3333-444455556666";

  it("pull_request opened with attachment url sets ingest", () => {
    const ev = extractWebhookEvent("pull_request", {
      action: "opened",
      repository: { full_name: "acme/app" },
      pull_request: { number: 7, body: `hello ${URL}` },
    });
    expect(ev?.ingest).toEqual({ repo: "acme/app", kind: "pull", num: 7, source: "body" });
  });

  it("pull_request opened without attachment url sets no ingest", () => {
    const ev = extractWebhookEvent("pull_request", {
      action: "opened",
      repository: { full_name: "acme/app" },
      pull_request: { number: 7, body: "hi" },
    });
    expect(ev?.ingest).toBeUndefined();
  });

  it("issues edited with a body change always sets ingest (removal case)", () => {
    const ev = extractWebhookEvent("issues", {
      action: "edited",
      changes: { body: { from: "old" } },
      repository: { full_name: "acme/app" },
      issue: { number: 3, body: "no urls anymore" },
    });
    expect(ev?.ingest).toEqual({ repo: "acme/app", kind: "issues", num: 3, source: "body" });
  });

  it("issues edited title-only (no changes.body) sets no ingest", () => {
    const ev = extractWebhookEvent("issues", {
      action: "edited",
      changes: { title: { from: "old title" } },
      repository: { full_name: "acme/app" },
      issue: { number: 3, body: `still has ${URL}` },
    });
    expect(ev?.ingest).toBeUndefined();
  });

  it("issue_comment created with url sets ingest with comment source", () => {
    const ev = extractWebhookEvent("issue_comment", {
      action: "created",
      repository: { full_name: "acme/app" },
      issue: { number: 7, pull_request: {} },
      comment: { id: 44, body: URL, user: { login: "octocat", type: "User" } },
    });
    expect(ev?.ingest).toEqual({ repo: "acme/app", kind: "pull", num: 7, source: "comment:44" });
  });

  it("issue_comment created without url sets no ingest", () => {
    const ev = extractWebhookEvent("issue_comment", {
      action: "created",
      repository: { full_name: "acme/app" },
      issue: { number: 7, pull_request: {} },
      comment: { id: 44, body: "plain text", user: { login: "octocat", type: "User" } },
    });
    expect(ev).toBeNull();
  });

  it("issue_comment edited always sets ingest; deleted sets ingest only when the removed body had a url", () => {
    const edited = extractWebhookEvent("issue_comment", {
      action: "edited",
      repository: { full_name: "acme/app" },
      issue: { number: 7, pull_request: {} },
      comment: {
        id: 44,
        body: "no urls in the new body",
        user: { login: "octocat", type: "User" },
      },
      sender: { login: "octocat", type: "User" },
    });
    expect(edited?.ingest).toEqual({
      repo: "acme/app",
      kind: "pull",
      num: 7,
      source: "comment:44",
    });

    const editedByBot = extractWebhookEvent("issue_comment", {
      action: "edited",
      repository: { full_name: "acme/app" },
      issue: { number: 7, pull_request: {} },
      comment: { id: 44, body: "our own write", user: { login: "our-bot", type: "Bot" } },
      sender: { login: "our-bot", type: "Bot" },
    });
    expect(editedByBot?.ingest).toBeUndefined();

    const deletedWithUrl = extractWebhookEvent("issue_comment", {
      action: "deleted",
      repository: { full_name: "acme/app" },
      issue: { number: 7, pull_request: {} },
      comment: { id: 44, body: URL, user: { login: "octocat", type: "User" } },
    });
    expect(deletedWithUrl?.ingest).toEqual({
      repo: "acme/app",
      kind: "pull",
      num: 7,
      source: "comment:44",
    });

    const deletedPlainText = extractWebhookEvent("issue_comment", {
      action: "deleted",
      repository: { full_name: "acme/app" },
      issue: { number: 7, pull_request: {} },
      comment: { id: 44, body: "plain text", user: { login: "octocat", type: "User" } },
    });
    expect(deletedPlainText?.ingest).toBeUndefined();
  });

  const UPLOADS_URL = "https://storage.uploads.sh/acme/f/shot.png";

  it("pull_request opened with a link sets adopt", () => {
    const ev = extractWebhookEvent("pull_request", {
      action: "opened",
      repository: { full_name: "acme/app" },
      pull_request: { number: 7, body: `screenshot: ${UPLOADS_URL}` },
    });
    expect(ev?.adopt).toEqual({ repo: "acme/app", kind: "pull", num: 7, source: "body" });
  });

  it("pull_request opened without any link sets no adopt", () => {
    const ev = extractWebhookEvent("pull_request", {
      action: "opened",
      repository: { full_name: "acme/app" },
      pull_request: { number: 7, body: "hi" },
    });
    expect(ev?.adopt).toBeUndefined();
  });

  it("issues edited with a body change always sets adopt (removal case)", () => {
    const ev = extractWebhookEvent("issues", {
      action: "edited",
      changes: { body: { from: "old" } },
      repository: { full_name: "acme/app" },
      issue: { number: 3, body: "no links anymore" },
    });
    expect(ev?.adopt).toEqual({ repo: "acme/app", kind: "issues", num: 3, source: "body" });
  });

  it("issue_comment created with a link sets adopt with comment source", () => {
    const ev = extractWebhookEvent("issue_comment", {
      action: "created",
      repository: { full_name: "acme/app" },
      issue: { number: 7, pull_request: {} },
      comment: { id: 44, body: UPLOADS_URL, user: { login: "octocat", type: "User" } },
    });
    expect(ev?.adopt).toEqual({ repo: "acme/app", kind: "pull", num: 7, source: "comment:44" });
  });

  it("issue_comment deleted never sets adopt (nothing left to rescan)", () => {
    const ev = extractWebhookEvent("issue_comment", {
      action: "deleted",
      repository: { full_name: "acme/app" },
      issue: { number: 7, pull_request: {} },
      comment: { id: 44, body: UPLOADS_URL, user: { login: "octocat", type: "User" } },
    });
    expect(ev?.adopt).toBeUndefined();
  });

  it("issue_comment edited by our own bot sets no adopt (loop guard)", () => {
    const ev = extractWebhookEvent("issue_comment", {
      action: "edited",
      repository: { full_name: "acme/app" },
      issue: { number: 7, pull_request: {} },
      comment: { id: 44, body: "our own write", user: { login: "our-bot", type: "Bot" } },
      sender: { login: "our-bot", type: "Bot" },
    });
    expect(ev?.adopt).toBeUndefined();
  });
});

describe("handleWebhook producer path", () => {
  const issuesPayload = {
    action: "edited",
    repository: { full_name: "o/r" },
    issue: { number: 1 },
  };

  it("enqueues the compact event and defers all processing", async () => {
    const kv = new FakeKv();
    kv.store.set("ghref:o/r#1", { value: "{}" });
    const queue = new FakeQueue();
    await handleWebhook(envWith(kv, queue), "issues", issuesPayload);
    expect(queue.sent).toEqual([{ keys: ["ghref:o/r#1"] }]);
    // Not deleted inline — the consumer owns the delete now.
    expect(kv.store.has("ghref:o/r#1")).toBe(true);
  });

  it("enqueues nothing for a no-work delivery", async () => {
    const queue = new FakeQueue();
    await handleWebhook(envWith(new FakeKv(), queue), "ping", {});
    expect(queue.sent).toEqual([]);
  });

  it("falls back to inline processing when the send fails", async () => {
    const kv = new FakeKv();
    kv.store.set("ghref:o/r#1", { value: "{}" });
    const queue = new FakeQueue();
    queue.fail = true;
    await handleWebhook(envWith(kv, queue), "issues", issuesPayload);
    expect(kv.store.has("ghref:o/r#1")).toBe(false);
  });

  it("processes inline when GITHUB_WEBHOOK_QUEUE is absent entirely (issue #754 item 3: self-hosters may skip the queue)", async () => {
    const kv = new FakeKv();
    kv.store.set("ghref:o/r#1", { value: "{}" });
    // No queue at all — envWith(kv, undefined) leaves GITHUB_WEBHOOK_QUEUE unset.
    await expect(
      handleWebhook({ GITHUB_CACHE: kv } as unknown as Env, "issues", issuesPayload),
    ).resolves.toBeUndefined();
    // Same signal as the "send fails" case above: the inline path ran and
    // consumed the reconcile-cache entry (the consumer-owned delete never
    // gets a chance to run without a queue).
    expect(kv.store.has("ghref:o/r#1")).toBe(false);
  });
});

describe("handleGithubWebhookBatch", () => {
  it("processes and acks each message", async () => {
    const kv = new FakeKv();
    kv.store.set("ghtok:42", { value: "t" });
    const m = msg({ keys: ["ghtok:42"] });
    await handleGithubWebhookBatch(batch(GITHUB_WEBHOOK_QUEUE, [m]), envWith(kv));
    expect(kv.store.has("ghtok:42")).toBe(false);
    expect(m.acked).toBe(true);
    expect(m.retried).toBe(false);
  });

  it("retries a message whose processing throws, without failing batchmates", async () => {
    // A promote event against an env whose DB is unusable → findRepoLink
    // throws → the consumer must msg.retry() (toward the DLQ), not crash.
    const env = {
      GITHUB_CACHE: new FakeKv(),
      DB: {
        prepare() {
          throw new Error("d1 down");
        },
      },
    } as unknown as Env;
    const failing = msg({ keys: [], promote: { repo: "o/r", num: 1, branch: "b" } });
    const fine = msg({ keys: [] });
    await handleGithubWebhookBatch(batch(GITHUB_WEBHOOK_QUEUE, [failing, fine]), env);
    expect(failing.retried).toBe(true);
    expect(failing.acked).toBe(false);
    expect(fine.acked).toBe(true);
  });

  it("acks DLQ messages without processing them", async () => {
    const kv = new FakeKv();
    kv.store.set("ghtok:42", { value: "t" });
    const m = msg({ keys: ["ghtok:42"] });
    await handleGithubWebhookBatch(batch(GITHUB_WEBHOOK_DLQ, [m]), envWith(kv));
    expect(kv.store.has("ghtok:42")).toBe(true); // untouched — terminal log only.
    expect(m.acked).toBe(true);
    expect(m.retried).toBe(false);
  });

  it("dispatches ingest events to ingestForWebhook and acks", async () => {
    vi.mocked(ingestForWebhook).mockResolvedValueOnce(undefined);
    const ref = { repo: "acme/app", kind: "pull" as const, num: 7, source: "body" };
    const m = msg({ keys: [], ingest: ref });
    await handleGithubWebhookBatch(batch(GITHUB_WEBHOOK_QUEUE, [m]), envWith(new FakeKv()));
    expect(ingestForWebhook).toHaveBeenCalledWith(expect.anything(), ref);
    expect(m.acked).toBe(true);
    expect(m.retried).toBe(false);
  });

  it("retries a message whose ingestForWebhook throws", async () => {
    vi.mocked(ingestForWebhook).mockRejectedValueOnce(new Error("transient"));
    const ref = { repo: "acme/app", kind: "pull" as const, num: 7, source: "body" };
    const m = msg({ keys: [], ingest: ref });
    await handleGithubWebhookBatch(batch(GITHUB_WEBHOOK_QUEUE, [m]), envWith(new FakeKv()));
    expect(m.retried).toBe(true);
  });

  it("dispatches adopt events to adoptLinkedFilesForWebhook and acks", async () => {
    vi.mocked(adoptLinkedFilesForWebhook).mockResolvedValueOnce(undefined);
    const ref = { repo: "acme/app", kind: "pull" as const, num: 7, source: "body" };
    const m = msg({ keys: [], adopt: ref });
    await handleGithubWebhookBatch(batch(GITHUB_WEBHOOK_QUEUE, [m]), envWith(new FakeKv()));
    expect(adoptLinkedFilesForWebhook).toHaveBeenCalledWith(expect.anything(), ref);
    expect(m.acked).toBe(true);
    expect(m.retried).toBe(false);
  });

  it("retries a message whose adoptLinkedFilesForWebhook throws", async () => {
    vi.mocked(adoptLinkedFilesForWebhook).mockRejectedValueOnce(new Error("transient"));
    const ref = { repo: "acme/app", kind: "pull" as const, num: 7, source: "body" };
    const m = msg({ keys: [], adopt: ref });
    await handleGithubWebhookBatch(batch(GITHUB_WEBHOOK_QUEUE, [m]), envWith(new FakeKv()));
    expect(m.retried).toBe(true);
    expect(m.acked).toBe(false);
  });
});
