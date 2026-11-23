import { describe, expect, it } from "vitest";
import {
  DEFAULT_TTL_MS,
  EVENTS_ERROR,
  MAX_TTL_MS,
  MIN_TTL_MS,
  deliverEvent,
  deliverHoldEvents,
  fileContext,
  grantTtlMs,
  parseCallbackUrl,
  parseFilter,
  parseWebhookSecret,
  subscribeEvent,
  unsubscribeEvent,
} from "../src/mcp-events";

const SECRET_BYTES = new Uint8Array(32).map((_, i) => i + 1);
const SECRET = `whsec_${btoa(String.fromCharCode(...SECRET_BYTES))}`;
const URL_ = "https://hooks.example.com/mcp/cb_1";
const principal = { workspace: "acme", userId: "user-1" };
const noSleep = async () => {};

function fakeKv() {
  const store = new Map<string, { value: string; ttl?: number }>();
  return {
    store,
    get: async (key: string) => store.get(key)?.value ?? null,
    put: async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, { value, ttl: opts?.expirationTtl });
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async ({ prefix }: { prefix: string }) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
      cursor: "",
    }),
  };
}

function makeEnv(members: string[] = ["user-1"]) {
  const kv = fakeKv();
  const env = {
    REGISTRY: kv,
    WORKSPACE_SECRETS_KEY: "test-secrets-key-0123456789",
    WEB_ORIGIN: "https://uploads.sh",
    DB: {
      prepare: () => {
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) {
            values = next;
            return this;
          },
          async first() {
            return members.includes(values[1] as string) ? { ok: 1 } : null;
          },
        };
      },
    },
  } as unknown as Env;
  return { env, kv };
}

type Call = { url: string; headers: Record<string, string>; body: string };

/** A receiver that echoes verification challenges and answers events with `status`. */
function receiver(statuses: number[] = [200]) {
  const calls: Call[] = [];
  let eventCalls = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = String(init?.body);
    calls.push({ url: String(input), headers, body });
    const parsed = JSON.parse(body) as { type?: string; challenge?: string };
    if (parsed.type === "verification") {
      return Response.json({ challenge: parsed.challenge });
    }
    const status = statuses[Math.min(eventCalls++, statuses.length - 1)]!;
    return new Response(null, { status });
  }) as typeof fetch;
  return { calls, fetcher };
}

async function expectedSignature(id: string, timestamp: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    SECRET_BYTES,
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

const subscribeParams = (extra: Record<string, unknown> = {}) => ({
  name: "upload.held",
  arguments: { repo: "Acme/Web" },
  delivery: { mode: "webhook", url: URL_, secret: SECRET },
  cursor: null,
  ...extra,
});

describe("validation", () => {
  it("accepts repo and pr filters and lowercases the repo", () => {
    expect(parseFilter({ repo: "Acme/Web", pr: 12 })).toEqual({ repo: "acme/web", pr: 12 });
    expect(parseFilter(undefined)).toEqual({});
  });

  it("rejects unknown arguments, a bad pr, and pr without repo", () => {
    expect(() => parseFilter({ branch: "main" })).toThrow(/Unknown argument/);
    expect(() => parseFilter({ repo: "a/b", pr: 0 })).toThrow(/positive integer/);
    expect(() => parseFilter({ pr: 3 })).toThrow(/requires/);
  });

  it("only takes https callbacks on public host names", () => {
    expect(parseCallbackUrl("https://hooks.example.com/a#x")).toBe("https://hooks.example.com/a");
    for (const bad of [
      "http://hooks.example.com/a",
      "https://127.0.0.1/a",
      "https://[::1]/a",
      "https://localhost/a",
      "https://printer.local/a",
      "https://intranet/a",
      "https://user:pw@hooks.example.com/a",
      "https://hooks.example.com:8443/a",
    ]) {
      expect(() => parseCallbackUrl(bad), bad).toThrow();
    }
  });

  it("requires a whsec_ secret of 24 to 64 bytes", () => {
    expect(parseWebhookSecret(SECRET)).toHaveLength(32);
    expect(() => parseWebhookSecret("plain")).toThrow();
    expect(() => parseWebhookSecret(`whsec_${btoa("short")}`)).toThrow(/24 to 64/);
  });

  it("grants a default, clamps, and never grants no expiry", () => {
    expect(grantTtlMs(undefined)).toBe(DEFAULT_TTL_MS);
    expect(grantTtlMs(null)).toBe(MAX_TTL_MS);
    expect(grantTtlMs(1)).toBe(MIN_TTL_MS);
    expect(grantTtlMs(10 * MAX_TTL_MS)).toBe(MAX_TTL_MS);
  });

  it("reads repo and PR from metadata or the attachment key", () => {
    expect(fileContext("gh/acme/web/pull/7/shot.png", {})).toEqual({ repo: "acme/web", pr: 7 });
    expect(
      fileContext("screenshots/a.png", {
        "gh.repo": "acme/web",
        "gh.kind": "pull",
        "gh.number": "9",
      }),
    ).toEqual({ repo: "acme/web", pr: 9 });
    expect(fileContext("screenshots/a.png", {})).toEqual({});
  });
});

describe("subscribeEvent", () => {
  it("verifies a new endpoint, then stores a sealed secret with the granted TTL", async () => {
    const { env, kv } = makeEnv();
    const { calls, fetcher } = receiver();
    const result = await subscribeEvent(
      env,
      principal,
      subscribeParams({ ttlMs: 3_600_000 }),
      fetcher,
    );
    expect(result).toMatchObject({ resultType: "complete", cursor: null, truncated: false });
    expect(result.id).toMatch(/^sub_/);
    expect(Date.parse(result.refreshBefore) - Date.now()).toBeGreaterThan(3_590_000);

    expect(calls).toHaveLength(1);
    const verify = calls[0]!;
    expect(verify.headers["x-mcp-subscription-id"]).toBe(result.id);
    expect(verify.headers["webhook-id"]).toMatch(/^msg_verification_/);
    expect(verify.headers["webhook-signature"]).toBe(
      await expectedSignature(
        verify.headers["webhook-id"]!,
        verify.headers["webhook-timestamp"]!,
        verify.body,
      ),
    );

    const [entry] = [...kv.store.values()];
    expect(entry!.ttl).toBe(3600);
    expect(entry!.value).not.toContain(SECRET);
    expect(JSON.parse(entry!.value)).toMatchObject({
      name: "upload.held",
      filter: { repo: "acme/web" },
    });
  });

  it("refreshes the same key without a second challenge, whatever the key order", async () => {
    const { env, kv } = makeEnv();
    const { calls, fetcher } = receiver();
    const first = await subscribeEvent(env, principal, subscribeParams(), fetcher);
    const again = await subscribeEvent(
      env,
      principal,
      subscribeParams({ arguments: { repo: "acme/web" } }),
      fetcher,
    );
    expect(again.id).toBe(first.id);
    expect(calls).toHaveLength(1);
    expect(kv.store.size).toBe(1);
  });

  it("gives another user a different subscription", async () => {
    const { env } = makeEnv(["user-1", "user-2"]);
    const { fetcher } = receiver();
    const a = await subscribeEvent(env, principal, subscribeParams(), fetcher);
    const b = await subscribeEvent(
      env,
      { ...principal, userId: "user-2" },
      subscribeParams(),
      fetcher,
    );
    expect(a.id).not.toBe(b.id);
  });

  it("fails with CallbackEndpointError when the challenge is not echoed", async () => {
    const { env, kv } = makeEnv();
    const fetcher = (async () => Response.json({ challenge: "nope" })) as unknown as typeof fetch;
    await expect(subscribeEvent(env, principal, subscribeParams(), fetcher)).rejects.toMatchObject({
      code: EVENTS_ERROR.CallbackEndpointError,
      data: { reason: "challenge_failed" },
    });
    expect(kv.store.size).toBe(0);
  });

  it("rejects other delivery modes and unknown events", async () => {
    const { env } = makeEnv();
    await expect(
      subscribeEvent(env, principal, subscribeParams({ delivery: { mode: "poll" } })),
    ).rejects.toMatchObject({ code: EVENTS_ERROR.Unsupported });
    await expect(
      subscribeEvent(env, principal, subscribeParams({ name: "upload.deleted" })),
    ).rejects.toMatchObject({ code: EVENTS_ERROR.NotFound });
  });

  it("unsubscribes idempotently", async () => {
    const { env, kv } = makeEnv();
    const { fetcher } = receiver();
    await subscribeEvent(env, principal, subscribeParams(), fetcher);
    const params = {
      name: "upload.held",
      arguments: { repo: "acme/web" },
      delivery: { url: URL_ },
    };
    await expect(unsubscribeEvent(env, principal, params)).resolves.toEqual({
      resultType: "complete",
    });
    expect(kv.store.size).toBe(0);
    await expect(unsubscribeEvent(env, principal, params)).resolves.toEqual({
      resultType: "complete",
    });
  });
});

describe("deliverEvent", () => {
  const data = {
    workspace: "acme",
    key: "gh/acme/web/pull/7/a.png",
    pageUrl: "https://x",
    reason: "secret",
  };

  it("POSTs a signed event to matching subscriptions only", async () => {
    const { env } = makeEnv();
    const { calls, fetcher } = receiver();
    const sub = await subscribeEvent(env, principal, subscribeParams(), fetcher);
    await subscribeEvent(
      env,
      principal,
      subscribeParams({ arguments: { repo: "acme/other" } }),
      fetcher,
    );
    await subscribeEvent(env, principal, subscribeParams({ name: "upload.approved" }), fetcher);
    calls.length = 0;

    const delivered = await deliverEvent(
      env,
      "acme",
      "upload.held",
      "upload.held|acme|k|t",
      { repo: "acme/web", pr: 7 },
      data,
      { fetch: fetcher, sleep: noSleep },
    );
    expect(delivered).toBe(1);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body).toMatchObject({ name: "upload.held", data, cursor: null });
    expect(call.headers["webhook-id"]).toBe(body.eventId);
    expect(call.headers["x-mcp-subscription-id"]).toBe(sub.id);
    expect(call.headers["webhook-signature"]).toBe(
      await expectedSignature(
        call.headers["webhook-id"]!,
        call.headers["webhook-timestamp"]!,
        call.body,
      ),
    );
  });

  it("retries a 5xx with the same event id, and stops on 410", async () => {
    const { env } = makeEnv();
    const flaky = receiver([503, 200]);
    await subscribeEvent(env, principal, subscribeParams(), flaky.fetcher);
    flaky.calls.length = 0;
    const ctx = { repo: "acme/web" };
    expect(
      await deliverEvent(env, "acme", "upload.held", "u1", ctx, data, {
        fetch: flaky.fetcher,
        sleep: noSleep,
      }),
    ).toBe(1);
    expect(flaky.calls).toHaveLength(2);
    expect(flaky.calls[0]!.headers["webhook-id"]).toBe(flaky.calls[1]!.headers["webhook-id"]);

    const gone = receiver([410]);
    await subscribeEvent(env, principal, subscribeParams(), gone.fetcher);
    gone.calls.length = 0;
    expect(
      await deliverEvent(env, "acme", "upload.held", "u2", ctx, data, {
        fetch: gone.fetcher,
        sleep: noSleep,
      }),
    ).toBe(0);
    expect(gone.calls).toHaveLength(1);
  });

  it("drops the subscription when its user left the workspace", async () => {
    const members = ["user-1"];
    const { env, kv } = makeEnv(members);
    const { calls, fetcher } = receiver();
    await subscribeEvent(env, principal, subscribeParams(), fetcher);
    calls.length = 0;
    members.length = 0;
    expect(
      await deliverEvent(env, "acme", "upload.held", "u3", { repo: "acme/web" }, data, {
        fetch: fetcher,
        sleep: noSleep,
      }),
    ).toBe(0);
    expect(calls).toHaveLength(0);
    expect(kv.store.size).toBe(0);
  });
});

describe("deliverHoldEvents", () => {
  it("sends one event per file with its PR context, skipping work when nobody subscribed", async () => {
    const { env } = makeEnv();
    const { calls, fetcher } = receiver();
    const files = [
      { key: "gh/acme/web/pull/7/a.png", meta: {} },
      { key: "screenshots/a.png", meta: {} },
    ];
    const extra = { reason: "secret", at: "2026-11-23T00:00:00.000Z" };
    expect(await deliverHoldEvents(env, "acme", "upload.held", files, extra)).toBe(0);

    await subscribeEvent(
      env,
      principal,
      subscribeParams({ arguments: { repo: "acme/web", pr: 7 } }),
      fetcher,
    );
    calls.length = 0;
    const deps = { fetch: fetcher, sleep: async () => {} };
    expect(await deliverHoldEvents(env, "acme", "upload.held", files, extra, deps)).toBe(1);
    expect(JSON.parse(calls[0]!.body).data).toEqual({
      workspace: "acme",
      key: "gh/acme/web/pull/7/a.png",
      pageUrl: "https://uploads.sh/f/acme/gh/acme/web/pull/7/a.png",
      repo: "acme/web",
      pr: 7,
      reason: "secret",
    });
  });
});
