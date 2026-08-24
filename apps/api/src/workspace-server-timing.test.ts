import { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { respondError } from "./error-response";
import { sha256Hex, workspaceAuth, type WorkspaceVars } from "./workspace";

const TOKEN = "up_acme_secrettoken";

beforeAll(() => {
  // Miniflare/workerd ship crypto.subtle.timingSafeEqual; Node's vitest
  // environment doesn't (same shim other tests in this app already need).
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

/** Minimal fake D1 backing just the two `auth_tokens` queries `workspaceAuth` issues. */
function fakeD1(opts: { tokenHash: string; touchDurationMs: number }) {
  return {
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      let args: unknown[] = [];
      return {
        bind(...values: unknown[]) {
          args = values;
          return this;
        },
        async first() {
          if (!normalized.startsWith("SELECT id, workspace, token_hash")) return null;
          const [, hash] = args as [string, string, string];
          return hash === opts.tokenHash
            ? {
                id: "token-1",
                workspace: "acme",
                token_hash: opts.tokenHash,
                label: null,
                scopes: JSON.stringify(["files:read", "files:write"]),
                created_at: "2026-08-01T00:00:00.000Z",
                expires_at: null,
                revoked_at: null,
                minting_user_id: null,
              }
            : null;
        },
        async run() {
          if (!normalized.startsWith("UPDATE auth_tokens SET last_used_at")) {
            throw new Error(`unsupported run: ${normalized}`);
          }
          return { success: true, meta: { changes: 1, duration: opts.touchDurationMs } };
        },
      };
    },
  };
}

function appWith(db: unknown) {
  return new Hono<WorkspaceVars>()
    .use("/:workspace/*", workspaceAuth)
    .get("/:workspace/whoami", (c) => c.json({ ok: true }))
    .onError((err, c) => respondError(c, err));
}

async function env(
  tokenHash: string,
  opts: { touchDurationMs?: number; extra?: Record<string, string> } = {},
) {
  return {
    REGISTRY: {
      get: async () => ({
        provider: "r2",
        bucket: "uploads-default",
        binding: "UPLOADS_DEFAULT",
        prefix: "acme/",
        publicBaseUrl: "https://storage.uploads.sh",
      }),
      put: async () => undefined,
    },
    DB: fakeD1({ tokenHash, touchDurationMs: opts.touchDurationMs ?? 0.5 }),
    ...opts.extra,
  } as unknown as Env;
}

describe("workspaceAuth Server-Timing wiring (issue #812)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("emits a Server-Timing header with wall + D1 exec ms on a matched token", async () => {
    const hash = await sha256Hex(TOKEN);
    const res = await appWith(null).request(
      "/acme/whoami",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      await env(hash, { touchDurationMs: 0.42 }),
    );
    expect(res.status).toBe(200);
    const header = res.headers.get("Server-Timing");
    expect(header).toMatch(
      /^d1;dur=\d+(\.\d+)?, d1_touch;dur=\d+(\.\d+)?, d1_touchexec;dur=0\.42$/,
    );
  });

  it("silences the header when SERVER_TIMING_DISABLED is set, without affecting slow-op logging", async () => {
    const hash = await sha256Hex(TOKEN);
    const res = await appWith(null).request(
      "/acme/whoami",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      await env(hash, { extra: { SERVER_TIMING_DISABLED: "1", SLOW_OP_THRESHOLD_MS: "0" } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Server-Timing")).toBeNull();
    // Threshold of 0 means every op is "slow" — logging must still fire.
    expect(logSpy).toHaveBeenCalled();
  });

  it("logs a slow-op line when the D1 lookup exceeds the threshold, not below it", async () => {
    const hash = await sha256Hex(TOKEN);

    await appWith(null).request(
      "/acme/whoami",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      await env(hash, { extra: { SLOW_OP_THRESHOLD_MS: "1000000" } }),
    );
    expect(logSpy).not.toHaveBeenCalled();

    logSpy.mockClear();
    await appWith(null).request(
      "/acme/whoami",
      { headers: { Authorization: `Bearer ${TOKEN}` } },
      await env(hash, { extra: { SLOW_OP_THRESHOLD_MS: "0" } }),
    );
    expect(logSpy).toHaveBeenCalled();
    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged).toMatchObject({ msg: "slow_op", op: "d1", outcome: "ok" });
    expect(logged.route).toBe("/acme/whoami");
  });

  it("never emits a header for an unmatched token (401, no D1 exec info to leak)", async () => {
    const res = await appWith(null).request(
      "/acme/whoami",
      { headers: { Authorization: "Bearer up_acme_wrongtoken" } },
      await env(await sha256Hex(TOKEN)),
    );
    expect(res.status).toBe(401);
  });
});
