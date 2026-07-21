/**
 * Queue-path ingestion for GitHub webhooks (issue #287): producer behavior in
 * `handleWebhook` (enqueue the compact event, inline fallback on a missing
 * binding or a failed send) and the consumer in github-webhook-queue.ts
 * (process/ack, retry-on-failure, DLQ log-and-ack). The extraction and
 * processing semantics themselves are covered by github-webhook.test.ts and
 * the auto-promote/reconcile suites, which exercise the queueless inline path.
 */
import { describe, expect, it } from "vitest";
import { extractWebhookEvent, handleWebhook, type WebhookEvent } from "./github-webhook";
import {
  GITHUB_WEBHOOK_DLQ,
  GITHUB_WEBHOOK_QUEUE,
  handleGithubWebhookBatch,
} from "./github-webhook-queue";
import { FakeKv } from "../test/fake-kv";

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
});
