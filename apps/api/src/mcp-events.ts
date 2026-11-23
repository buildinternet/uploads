/**
 * MCP Events (`io.modelcontextprotocol/events`, SEP-3415), webhook delivery
 * only. The hosted MCP (apps/mcp/src/events.ts) answers `events/list`,
 * `events/subscribe` and `events/unsubscribe` with the functions here, and
 * the hold service calls `emitHoldEvent` when a hold is placed or approved.
 * Both run in whichever worker made the change (uploads-api or uploads-mcp),
 * so this module only needs `REGISTRY`, `DB` and
 * `WORKSPACE_SECRETS_KEY`.
 *
 * Storage: one KV entry per subscription in `REGISTRY`, keyed
 * `mcpev:<workspace>:<id>`, with a KV expiration equal to the granted TTL.
 * Delivery lists that prefix. No D1 tables or indexes. The webhook secret is
 * sealed with `WORKSPACE_SECRETS_KEY`, like BYO credentials.
 *
 * What is not here: poll and push delivery (ChatGPT and most clients only
 * use webhooks), replay (`cursor` is always null), `gap` and `terminated`
 * envelopes, and `deliveryStatus`. Retries stay inside the request's
 * `waitUntil` window (three attempts over about ten seconds).
 *
 * SSRF: the spec asks servers to resolve the callback host and refuse
 * private addresses at delivery time. A Worker cannot pin a resolved IP, but
 * its `fetch` also cannot reach private networks. Here, callbacks must be
 * `https` on port 443 with a public-looking DNS name (no IP literals, no
 * `localhost`/`.local`/`.internal`), and redirects are never followed.
 *
 * No Flagship gate: uploads-mcp has no `FLAGS` binding, and adding one would
 * switch on every other flag there. Nothing is delivered until a client
 * subscribes.
 */

import { waitUntil } from "cloudflare:workers";
import { dbFor } from "./db-session";
import { filePageUrl } from "./files-core";
import { parseAttachmentKey } from "./github-attachment-index";
import { b64urlEncode, decryptSecret, encryptSecret, secretsKeyRingFromEnv } from "./secrets";

export const EVENTS_EXTENSION_ID = "io.modelcontextprotocol/events";

const KEY_PREFIX = "mcpev:";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Grant when the client sends no `ttlMs`. */
export const DEFAULT_TTL_MS = 7 * DAY_MS;
/** Longest grant, also used for `ttlMs: null` (no expiry is never granted). */
export const MAX_TTL_MS = 30 * DAY_MS;
/** KV's minimum expiration, and the spec's sanctioned clamp-up floor. */
export const MIN_TTL_MS = 60 * 1000;
/** Active subscriptions per workspace. */
export const MAX_SUBSCRIPTIONS_PER_WORKSPACE = 100;
const MAX_URL_LENGTH = 2048;
const MAX_BODY_BYTES = 256 * 1024;
const DELIVERY_TIMEOUT_MS = 5000;
/** Waits before attempts 2 and 3. */
const RETRY_DELAYS_MS = [2000, 6000];

/** JSON-RPC codes from SEP-3415 "Error Handling" (InvalidParams is the standard one). */
export const EVENTS_ERROR = {
  InvalidParams: -32602,
  NotFound: -32023,
  Forbidden: -32024,
  ResourceExhausted: -32025,
  Unsupported: -32026,
  CallbackEndpointError: -32027,
} as const;

/** A JSON-RPC error the MCP worker turns into a protocol error response. */
export class McpEventsError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "McpEventsError";
  }
}

export type HoldEventName = "upload.held" | "upload.approved";

const filterSchema = {
  type: "object",
  properties: {
    repo: {
      type: "string",
      description:
        "Only files for this GitHub repository, as owner/name (case-insensitive). Omit for every file in the workspace.",
    },
    pr: {
      type: "integer",
      minimum: 1,
      description: "Only files attached to this pull request number. Requires `repo`.",
    },
  },
  additionalProperties: false,
} as const;

const holdPayloadProperties = {
  workspace: { type: "string" },
  key: { type: "string", description: "Object key of the file." },
  pageUrl: {
    type: "string",
    description: "Signed-in file page, where a member can review and approve.",
  },
  repo: { type: "string", description: "GitHub repository (owner/name), when known." },
  pr: { type: "integer", description: "Pull request number, when the file is on one." },
} as const;

/** `events/list` entries. Evolve these additively (SEP-3415 "Schema evolution"). */
export const EVENT_TYPES = [
  {
    name: "upload.held",
    description:
      "A file was held for review because the classifier found a likely secret or personal data. The file stays private until a workspace member approves it.",
    delivery: ["webhook"],
    inputSchema: filterSchema,
    payloadSchema: {
      type: "object",
      properties: {
        ...holdPayloadProperties,
        reason: {
          type: "string",
          description: "Why it was held: secret or pii. More values may be added.",
        },
      },
      required: ["workspace", "key", "pageUrl", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "upload.approved",
    description:
      "A workspace member approved a held file, so it is public again and back in its PR comment.",
    delivery: ["webhook"],
    inputSchema: filterSchema,
    payloadSchema: {
      type: "object",
      properties: {
        ...holdPayloadProperties,
        approvedBy: { type: "string", description: "Who approved it, when known." },
      },
      required: ["workspace", "key", "pageUrl"],
      additionalProperties: false,
    },
  },
] as const;

const EVENT_NAMES = new Set<string>(EVENT_TYPES.map((event) => event.name));

/** Subscription filter, after validation. */
export interface EventFilter {
  repo?: string;
  pr?: number;
}

/** The KV value. */
interface StoredSubscription {
  v: 1;
  id: string;
  userId: string;
  name: HoldEventName;
  filter: EventFilter;
  url: string;
  /** Sealed with WORKSPACE_SECRETS_KEY (`enc:v1:`). */
  secret: string;
  createdAt: string;
  expiresAt: string;
}

/** Who is calling: the token's workspace and its signed-in user. */
export interface EventsPrincipal {
  workspace: string;
  userId: string;
}

function invalid(message: string, data?: Record<string, unknown>): McpEventsError {
  return new McpEventsError(EVENTS_ERROR.InvalidParams, message, data);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

function parseName(value: unknown): HoldEventName {
  if (typeof value !== "string" || !EVENT_NAMES.has(value)) {
    throw new McpEventsError(EVENTS_ERROR.NotFound, "Unknown event name", { kind: "event" });
  }
  return value as HoldEventName;
}

/** Validates `arguments` against `filterSchema`, by hand. */
export function parseFilter(value: unknown): EventFilter {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw invalid("arguments must be an object");
  const filter: EventFilter = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === "repo") {
      if (typeof raw !== "string" || !REPO_RE.test(raw)) {
        throw invalid("arguments.repo must be owner/name");
      }
      filter.repo = raw.toLowerCase();
    } else if (key === "pr") {
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
        throw invalid("arguments.pr must be a positive integer");
      }
      filter.pr = raw;
    } else {
      throw invalid(`Unknown argument: ${key}`);
    }
  }
  if (filter.pr !== undefined && filter.repo === undefined) {
    throw invalid("arguments.pr requires arguments.repo");
  }
  return filter;
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".test"];

/**
 * The callback URL, normalized, or InvalidParams. `https`, port 443, a DNS
 * name with a dot, no credentials, no IP literals.
 */
export function parseCallbackUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) {
    throw invalid("delivery.url must be an https URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("delivery.url must be an https URL");
  }
  if (url.protocol !== "https:") throw invalid("delivery.url must use https");
  if (url.username || url.password) throw invalid("delivery.url must not carry credentials");
  if (url.port && url.port !== "443") throw invalid("delivery.url must use port 443");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const ipLiteral = host.startsWith("[") || /^[\d.]+$/.test(host) || /^0x/i.test(host);
  if (
    ipLiteral ||
    !host.includes(".") ||
    host === "localhost" ||
    BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    throw invalid("delivery.url must be a public host name");
  }
  url.hash = "";
  return url.toString();
}

/** `whsec_` + base64 of 24 to 64 bytes. Returns the raw key bytes. */
export function parseWebhookSecret(value: unknown): Uint8Array {
  if (typeof value !== "string" || !value.startsWith("whsec_")) {
    throw invalid("delivery.secret must be a whsec_ secret");
  }
  let bytes: Uint8Array;
  try {
    const bin = atob(value.slice("whsec_".length));
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    throw invalid("delivery.secret must be a whsec_ secret");
  }
  if (bytes.length < 24 || bytes.length > 64) {
    throw invalid("delivery.secret must decode to 24 to 64 bytes");
  }
  return bytes;
}

/** Granted lifetime in ms for a requested `ttlMs` (absent, null, or a number). */
export function grantTtlMs(requested: unknown): number {
  if (requested === undefined) return DEFAULT_TTL_MS;
  if (requested === null) return MAX_TTL_MS;
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    throw invalid("ttlMs must be a number or null");
  }
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Math.floor(requested)));
}

/** Canonical JSON: object keys sorted, so key order never splits a subscription. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Deterministic over (principal, url, name, arguments), as the spec asks. */
export async function subscriptionId(
  principal: EventsPrincipal,
  url: string,
  name: string,
  filter: EventFilter,
): Promise<string> {
  const digest = await sha256(
    canonical([principal.workspace, principal.userId, url, name, filter]),
  );
  return `sub_${b64urlEncode(digest.subarray(0, 16))}`;
}

function kvKey(workspace: string, id: string): string {
  return `${KEY_PREFIX}${workspace}:${id}`;
}

async function hmacSign(secret: Uint8Array, id: string, timestamp: number, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  );
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
}

/** Category strings from SEP-3415 `lastError` / `CallbackEndpointError.data.reason`. */
type DeliveryFailure =
  | "connection_refused"
  | "timeout"
  | "tls_error"
  | "http_4xx"
  | "http_5xx"
  | "challenge_failed";

type PostResult =
  | { ok: true; response: Response }
  | { ok: false; reason: DeliveryFailure; status?: number };

/** One signed POST. Never follows redirects; a 3xx counts as a 4xx-class failure. */
async function signedPost(
  url: string,
  secret: Uint8Array,
  webhookId: string,
  subscription: string,
  body: string,
  fetcher: typeof fetch,
): Promise<PostResult> {
  const timestamp = Math.floor(Date.now() / 1000);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": await hmacSign(secret, webhookId, timestamp, body),
        "X-MCP-Subscription-Id": subscription,
      },
      body,
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const message = err instanceof Error ? err.message : String(err);
    if (name === "TimeoutError" || name === "AbortError") return { ok: false, reason: "timeout" };
    if (/tls|ssl|certificate/i.test(message)) return { ok: false, reason: "tls_error" };
    return { ok: false, reason: "connection_refused" };
  }
  if (response.status >= 200 && response.status < 300) return { ok: true, response };
  await response.body?.cancel().catch(() => undefined);
  return {
    ok: false,
    reason: response.status >= 500 ? "http_5xx" : "http_4xx",
    status: response.status,
  };
}

function randomToken(bytes: number): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Constant-time compare of two short strings. */
function sameString(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
  };
  if (subtle.timingSafeEqual) return subtle.timingSafeEqual(left, right);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

/** The verification handshake. Throws CallbackEndpointError when it fails. */
async function verifyEndpoint(
  url: string,
  secret: Uint8Array,
  id: string,
  fetcher: typeof fetch,
): Promise<void> {
  const challenge = randomToken(24);
  const result = await signedPost(
    url,
    secret,
    `msg_verification_${randomToken(12)}`,
    id,
    JSON.stringify({ type: "verification", challenge }),
    fetcher,
  );
  let reason: DeliveryFailure | null = result.ok ? null : result.reason;
  if (result.ok) {
    const body = (await result.response.json().catch(() => null)) as { challenge?: unknown } | null;
    const echoed = typeof body?.challenge === "string" ? body.challenge : "";
    if (!sameString(echoed, challenge)) reason = "challenge_failed";
  }
  if (reason) {
    throw new McpEventsError(
      EVENTS_ERROR.CallbackEndpointError,
      "The callback endpoint did not pass verification",
      { reason },
    );
  }
}

async function readSubscription(env: Env, key: string): Promise<StoredSubscription | null> {
  const raw = await env.REGISTRY.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSubscription;
    return parsed?.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}

async function listSubscriptionKeys(env: Env, workspace: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.REGISTRY.list({ prefix: `${KEY_PREFIX}${workspace}:`, cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && keys.length <= MAX_SUBSCRIPTIONS_PER_WORKSPACE * 2);
  return keys;
}

export interface SubscribeResult {
  resultType: "complete";
  id: string;
  refreshBefore: string;
  cursor: null;
  truncated: false;
}

/**
 * `events/subscribe`. Creates or refreshes the subscription for this key.
 * A new key is verified with a challenge first; a refresh is not, since the
 * key already includes the URL that passed.
 */
export async function subscribeEvent(
  env: Env,
  principal: EventsPrincipal,
  params: unknown,
  fetcher: typeof fetch = fetch,
): Promise<SubscribeResult> {
  if (!isRecord(params)) throw invalid("params must be an object");
  const name = parseName(params.name);
  const filter = parseFilter(params.arguments);
  const delivery = params.delivery;
  if (!isRecord(delivery)) throw invalid("delivery must be an object");
  if (delivery.mode !== "webhook") {
    throw new McpEventsError(EVENTS_ERROR.Unsupported, "Only webhook delivery is supported", {
      feature: "deliveryMode",
      value: delivery.mode ?? null,
    });
  }
  const url = parseCallbackUrl(delivery.url);
  const secretBytes = parseWebhookSecret(delivery.secret);
  const ttlMs = grantTtlMs(params.ttlMs);
  if (!env.WORKSPACE_SECRETS_KEY) {
    throw new McpEventsError(EVENTS_ERROR.Unsupported, "Events are not configured here", {
      feature: "webhook",
    });
  }

  const id = await subscriptionId(principal, url, name, filter);
  const key = kvKey(principal.workspace, id);
  const existing = await readSubscription(env, key);
  if (!existing) {
    const count = (await listSubscriptionKeys(env, principal.workspace)).length;
    if (count >= MAX_SUBSCRIPTIONS_PER_WORKSPACE) {
      throw new McpEventsError(EVENTS_ERROR.ResourceExhausted, "Too many subscriptions", {
        limit: "subscriptions",
        max: MAX_SUBSCRIPTIONS_PER_WORKSPACE,
      });
    }
    await verifyEndpoint(url, secretBytes, id, fetcher);
  }

  const now = Date.now();
  const expiresAt = new Date(now + ttlMs).toISOString();
  const record: StoredSubscription = {
    v: 1,
    id,
    userId: principal.userId,
    name,
    filter,
    url,
    secret: await encryptSecret(env.WORKSPACE_SECRETS_KEY, String(delivery.secret)),
    createdAt: existing?.createdAt ?? new Date(now).toISOString(),
    expiresAt,
  };
  await env.REGISTRY.put(key, JSON.stringify(record), {
    expirationTtl: Math.ceil(ttlMs / 1000),
  });
  console.log({
    event: existing ? "mcp_event_subscription_refreshed" : "mcp_event_subscribed",
    workspace: principal.workspace,
    name,
    id,
  });
  return { resultType: "complete", id, refreshBefore: expiresAt, cursor: null, truncated: false };
}

/** `events/unsubscribe`. Idempotent: an unknown key is not an error. */
export async function unsubscribeEvent(
  env: Env,
  principal: EventsPrincipal,
  params: unknown,
): Promise<{ resultType: "complete" }> {
  if (!isRecord(params)) throw invalid("params must be an object");
  const name = parseName(params.name);
  const filter = parseFilter(params.arguments);
  const delivery = isRecord(params.delivery) ? params.delivery : {};
  const url = parseCallbackUrl(delivery.url);
  const id = await subscriptionId(principal, url, name, filter);
  await env.REGISTRY.delete(kvKey(principal.workspace, id));
  console.log({ event: "mcp_event_unsubscribed", workspace: principal.workspace, name, id });
  return { resultType: "complete" };
}

/** Repo and PR for a file, from its metadata or its attachment key. */
export function fileContext(key: string, meta: Record<string, string>): EventFilter {
  const parsed = parseAttachmentKey(key);
  const repo = (meta["gh.repo"] || parsed?.repo || "").toLowerCase() || undefined;
  const number = Number(meta["gh.number"]);
  const kind = meta["gh.kind"] || parsed?.kind;
  const pr =
    kind === "pull"
      ? Number.isInteger(number) && number > 0
        ? number
        : parsed?.kind === "pull"
          ? parsed.num
          : undefined
      : undefined;
  return { ...(repo ? { repo } : {}), ...(pr ? { pr } : {}) };
}

function matches(filter: EventFilter, context: EventFilter): boolean {
  if (filter.repo !== undefined && filter.repo !== context.repo) return false;
  if (filter.pr !== undefined && filter.pr !== context.pr) return false;
  return true;
}

async function isMember(env: Env, workspace: string, userId: string): Promise<boolean> {
  const row = await dbFor(env)
    .prepare(
      `SELECT 1 AS ok FROM member m
         INNER JOIN organization o ON o.id = m.organization_id
        WHERE o.slug = ? AND m.user_id = ?`,
    )
    .bind(workspace, userId)
    .first<{ ok: number }>();
  return row !== null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Network seams, swapped in tests. */
export interface DeliveryDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Delivers one event to one subscription, with bounded retries. */
async function deliverToSubscription(
  env: Env,
  sub: StoredSubscription,
  upstreamId: string,
  name: HoldEventName,
  timestamp: string,
  data: Record<string, unknown>,
  deps: Required<DeliveryDeps>,
): Promise<boolean> {
  const { plaintext } = await decryptSecret(secretsKeyRingFromEnv(env), sub.secret);
  const secret = parseWebhookSecret(plaintext);
  // One id per (subscription, upstream event): stable across retries and
  // header-safe. ChatGPT expects `webhook-id` to equal `eventId`.
  const digest = await sha256(`${sub.id}|${upstreamId}`);
  const eventId = `evt_${b64urlEncode(digest.subarray(0, 18))}`;
  const body = JSON.stringify({ eventId, name, timestamp, data, cursor: null });
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) return false;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await deps.sleep(RETRY_DELAYS_MS[attempt - 1]!);
    const result = await signedPost(sub.url, secret, eventId, sub.id, body, deps.fetch);
    if (result.ok) {
      await result.response.body?.cancel().catch(() => undefined);
      return true;
    }
    if (result.status === 410 || result.status === 413) return false;
  }
  return false;
}

/**
 * Sends `name` to every matching subscription in `workspace`. Never throws.
 * Returns how many deliveries succeeded (tests and logs).
 */
export async function deliverEvent(
  env: Env,
  workspace: string,
  name: HoldEventName,
  upstreamId: string,
  context: EventFilter,
  data: Record<string, unknown>,
  deps: DeliveryDeps = {},
): Promise<number> {
  const seams = {
    fetch: deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)),
    sleep: deps.sleep ?? sleep,
  };
  try {
    const keys = await listSubscriptionKeys(env, workspace);
    if (keys.length === 0) return 0;
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const members = new Map<string, Promise<boolean>>();
    const deliverOne = async (key: string): Promise<boolean> => {
      const sub = await readSubscription(env, key);
      if (!sub || sub.name !== name || Date.parse(sub.expiresAt) <= now) return false;
      if (!matches(sub.filter, context)) return false;
      let member = members.get(sub.userId);
      if (!member) {
        member = isMember(env, workspace, sub.userId);
        members.set(sub.userId, member);
      }
      if (!(await member)) {
        // Access revoked: the subscription ends here.
        await env.REGISTRY.delete(key);
        console.log({ event: "mcp_event_subscription_revoked", workspace, id: sub.id });
        return false;
      }
      return deliverToSubscription(env, sub, upstreamId, name, timestamp, data, seams);
    };
    const results = await Promise.all(
      keys.map(async (key) => {
        try {
          return await deliverOne(key);
        } catch (err) {
          console.error({ event: "mcp_event_subscription_failed", workspace, name, err });
          return false;
        }
      }),
    );
    const delivered = results.filter(Boolean).length;
    console.log({ event: "mcp_event_delivered", workspace, name, delivered });
    return delivered;
  } catch (err) {
    console.error({ event: "mcp_event_delivery_failed", workspace, name, err });
    return 0;
  }
}

/**
 * Hold service hook: queue `upload.held` / `upload.approved` for each key
 * on the request's `waitUntil`, so slow webhooks never delay the caller.
 * Never throws.
 */
export function emitHoldEvent(
  env: Env,
  workspace: string,
  name: HoldEventName,
  files: { key: string; meta: Record<string, string> }[],
  extra: { reason?: string; approvedBy?: string | null; at: string },
): void {
  try {
    waitUntil(deliverHoldEvents(env, workspace, name, files, extra));
  } catch (err) {
    console.error({ event: "mcp_event_schedule_failed", workspace, name, err });
  }
}

/** The deferred half of `emitHoldEvent`. Exported for tests. */
export async function deliverHoldEvents(
  env: Env,
  workspace: string,
  name: HoldEventName,
  files: { key: string; meta: Record<string, string> }[],
  extra: { reason?: string; approvedBy?: string | null; at: string },
  deps: DeliveryDeps = {},
): Promise<number> {
  try {
    if ((await listSubscriptionKeys(env, workspace)).length === 0) return 0;
  } catch (err) {
    console.error({ event: "mcp_event_delivery_failed", workspace, name, err });
    return 0;
  }
  let delivered = 0;
  for (const { key, meta } of files) {
    try {
      const context = fileContext(key, meta);
      const data: Record<string, unknown> = {
        workspace,
        key,
        pageUrl: filePageUrl(env, workspace, key),
        ...context,
        ...(name === "upload.held" && extra.reason ? { reason: extra.reason } : {}),
        ...(name === "upload.approved" && extra.approvedBy ? { approvedBy: extra.approvedBy } : {}),
      };
      const upstreamId = `${name}|${workspace}|${key}|${extra.at}`;
      delivered += await deliverEvent(env, workspace, name, upstreamId, context, data, deps);
    } catch (err) {
      console.error({ event: "mcp_event_delivery_failed", workspace, name, err });
    }
  }
  return delivered;
}
