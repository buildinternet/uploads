#!/usr/bin/env node
/**
 * Re-enqueue dead-lettered GitHub webhook events onto uploads-github-webhook.
 *
 * The DLQ consumer logs one JSON line per event:
 *   {"message":"github webhook event dead-lettered","deliveryId":"…","event":{…}}
 * The operator email contains a JSON array of those `event` objects.
 *
 * Accepted input (a file, or stdin via `-`):
 *   - one compact event
 *   - a JSON array of compact events
 *   - a log line, or one log line per line (JSONL)
 *
 * Usage (from the repo root):
 *   node --env-file=.env apps/api/scripts/replay-github-webhook-dlq.mjs events.json
 *   node --env-file=.env apps/api/scripts/replay-github-webhook-dlq.mjs --dry-run events.json
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Queues Write).
 * `--dry-run` prints the events and does not call Cloudflare.
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CF_API = "https://api.cloudflare.com/client/v4";
const DEFAULT_QUEUE = "uploads-github-webhook";
/** Cloudflare's bulk push accepts at most 100 messages per request. */
const BATCH_LIMIT = 100;

class DeadLetterParseError extends Error {}

/**
 * @param {unknown} value
 * @returns {value is { keys: unknown[] }}
 */
function isEvent(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.keys);
}

/**
 * One compact event, unwrapping a DLQ log line (`{ event }`) when needed.
 * @param {unknown} value
 */
function oneEvent(value) {
  if (isEvent(value)) return value;
  if (value && typeof value === "object" && "event" in value && isEvent(value.event)) {
    return value.event;
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {object[]}
 */
function takeEvents(value) {
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      const event = oneEvent(item);
      if (!event) throw new DeadLetterParseError(`item ${i + 1} is not a webhook event`);
      return event;
    });
  }
  const event = oneEvent(value);
  if (!event) throw new DeadLetterParseError("input is not a webhook event");
  return [event];
}

/**
 * Parse a file of dead-lettered events. Throws when nothing usable is present.
 * @param {string} text
 * @returns {object[]}
 */
export function parseDeadLetterInput(text) {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) throw new DeadLetterParseError("no events");

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const events = takeEvents(JSON.parse(trimmed));
      if (events.length === 0) throw new DeadLetterParseError("no events");
      return events;
    } catch (err) {
      if (err instanceof DeadLetterParseError) throw err;
    }
  }

  /** @type {object[]} */
  const events = [];
  const lines = trimmed.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new DeadLetterParseError(`line ${i + 1} is not JSON`);
    }
    events.push(...takeEvents(value));
  }
  if (events.length === 0) throw new DeadLetterParseError("no events");
  return events;
}

/**
 * @param {Response} res
 */
async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/**
 * @param {unknown} payload
 * @param {number} status
 */
function apiError(payload, status) {
  const errors = payload && typeof payload === "object" ? payload.errors : undefined;
  const message = Array.isArray(errors) ? errors[0]?.message : undefined;
  return new Error(
    typeof message === "string" && message
      ? `Cloudflare API: ${message}`
      : `Cloudflare API request failed (${status})`,
  );
}

/**
 * Push compact events onto a queue. One HTTP batch per 100 events.
 * @param {object[]} events
 * @param {{
 *   accountId: string;
 *   token: string;
 *   queueName: string;
 *   fetchImpl?: typeof fetch;
 * }} opts
 * @returns {Promise<{ queueId: string; sent: number }>}
 */
export async function enqueueDeadLetters(events, opts) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = {
    authorization: `Bearer ${opts.token}`,
    "content-type": "application/json",
  };
  const listUrl = `${CF_API}/accounts/${opts.accountId}/queues?name=${encodeURIComponent(opts.queueName)}`;
  const listRes = await fetchImpl(listUrl, { headers });
  const listBody = await readJson(listRes);
  if (!listRes.ok || listBody.success === false) throw apiError(listBody, listRes.status);
  const queues = Array.isArray(listBody.result) ? listBody.result : [];
  const queue = queues.find((item) => item && item.queue_name === opts.queueName);
  if (!queue?.queue_id) throw new Error(`queue ${opts.queueName} not found`);

  let sent = 0;
  for (let i = 0; i < events.length; i += BATCH_LIMIT) {
    const slice = events.slice(i, i + BATCH_LIMIT);
    const res = await fetchImpl(
      `${CF_API}/accounts/${opts.accountId}/queues/${queue.queue_id}/messages/batch`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          messages: slice.map((body) => ({ body, content_type: "json" })),
        }),
      },
    );
    const payload = await readJson(res);
    if (!res.ok || payload.success === false) throw apiError(payload, res.status);
    sent += slice.length;
  }
  return { queueId: queue.queue_id, sent };
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{ dryRun: boolean; queue: string; file?: string }} */
  const opts = { dryRun: false, queue: DEFAULT_QUEUE };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "--queue") {
      const name = argv[++i];
      if (!name) throw new Error("--queue needs a name");
      opts.queue = name;
      continue;
    }
    if (arg === "--") continue;
    if (arg.startsWith("--")) throw new Error(`unknown flag: ${arg}`);
    if (opts.file) throw new Error("pass one file");
    opts.file = arg;
  }
  return opts;
}

/**
 * @param {string | undefined} file
 */
async function readInput(file) {
  if (file && file !== "-") return readFile(file, "utf8");
  if (!file && process.stdin.isTTY) {
    throw new Error("pass a JSON file of dead-lettered events, or - to read stdin");
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const events = parseDeadLetterInput(await readInput(opts.file));
  if (opts.dryRun) {
    console.log(`dry run: ${events.length} event(s) for ${opts.queue}`);
    for (const event of events) {
      const id =
        event && typeof event === "object" && "deliveryId" in event && event.deliveryId
          ? String(event.deliveryId)
          : "(no delivery id)";
      console.log(`  ${id}`);
    }
    return;
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required");
  const result = await enqueueDeadLetters(events, {
    accountId,
    token,
    queueName: opts.queue,
  });
  console.log(`enqueued ${result.sent} event(s) onto ${opts.queue}`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
