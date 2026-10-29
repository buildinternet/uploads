import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { renderWebhookDlqAlertEmail } from "@uploads/email";
import { enqueueDeadLetters, parseDeadLetterInput } from "./replay-github-webhook-dlq.mjs";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("./replay-github-webhook-dlq.mjs", import.meta.url));

const event = {
  keys: ["ghref:acme/app#7"],
  deliveryId: "delivery-1",
  ingest: { repo: "acme/app", kind: "pull", num: 7, source: "body" },
};

describe("parseDeadLetterInput", () => {
  it("reads one event, an array, and a dead-letter log line", () => {
    expect(parseDeadLetterInput(JSON.stringify(event))).toEqual([event]);
    expect(parseDeadLetterInput(JSON.stringify([event, { keys: [] }]))).toEqual([
      event,
      { keys: [] },
    ]);
    const log = JSON.stringify({
      message: "github webhook event dead-lettered",
      deliveryId: "delivery-1",
      event,
    });
    expect(parseDeadLetterInput(log)).toEqual([event]);
  });

  it("reads JSONL log lines, including a pretty-printed email payload", () => {
    const second = { keys: [], deliveryId: "delivery-2" };
    const jsonl = [
      JSON.stringify({ message: "github webhook event dead-lettered", event }),
      JSON.stringify({ message: "github webhook event dead-lettered", event: second }),
    ].join("\n");
    expect(parseDeadLetterInput(jsonl)).toEqual([event, second]);
    expect(parseDeadLetterInput(JSON.stringify([event, second], null, 2))).toEqual([event, second]);
  });

  it("parses the JSON array from the operator email", () => {
    const email = renderWebhookDlqAlertEmail({ events: [event, { keys: [] }] });
    const json = email.text.slice(email.text.indexOf("["));
    expect(parseDeadLetterInput(json)).toEqual([event, { keys: [] }]);
  });

  it("rejects input that is not a webhook event", () => {
    expect(() => parseDeadLetterInput("{}\n")).toThrow(/not a webhook event/);
    expect(() => parseDeadLetterInput("")).toThrow(/no events/);
    expect(() => parseDeadLetterInput("not json\n")).toThrow(/not JSON/);
  });
});

describe("enqueueDeadLetters", () => {
  it("resolves the queue by name and pushes JSON messages", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/queues?")) {
        return new Response(
          JSON.stringify({
            success: true,
            result: [{ queue_id: "qid-1", queue_name: "uploads-github-webhook" }],
          }),
        );
      }
      return new Response(JSON.stringify({ success: true }));
    }) as typeof fetch;

    const result = await enqueueDeadLetters([event], {
      accountId: "acct",
      token: "secret-token",
      queueName: "uploads-github-webhook",
      fetchImpl,
    });

    expect(result).toEqual({ queueId: "qid-1", sent: 1 });
    expect(calls[0]?.url).toContain("/accounts/acct/queues?name=uploads-github-webhook");
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer secret-token" });
    expect(calls[1]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/queues/qid-1/messages/batch",
    );
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      messages: [{ body: event, content_type: "json" }],
    });
  });

  it("surfaces an API error without the token", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: "auth failed" }] }), {
        status: 403,
      })) as typeof fetch;
    await expect(
      enqueueDeadLetters([event], {
        accountId: "acct",
        token: "secret-token",
        queueName: "uploads-github-webhook",
        fetchImpl,
      }),
    ).rejects.toThrow(/auth failed/);
  });
});

describe("replay script", () => {
  it("dry-run prints delivery ids and does not need credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "webhook-dlq-"));
    const file = join(dir, "events.json");
    await writeFile(file, JSON.stringify([event]));
    const { stdout } = await exec(process.execPath, [script, "--dry-run", file], {
      env: {},
    });
    expect(stdout).toContain("dry run: 1 event(s) for uploads-github-webhook");
    expect(stdout).toContain("delivery-1");
  });
});
