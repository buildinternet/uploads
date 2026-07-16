import { beforeAll, describe, expect, it } from "vitest";
import { FakeBrowser } from "./fake-browser";
import { UsageFakeD1 } from "./usage-fake-d1";
import { app } from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";

// tokenWorkspaceAuth (unlike the path-based workspaceAuth used by /v1/:workspace/*)
// resolves the workspace name from the token itself (`up_<name>_…`), so every
// token here must encode "default" to match the fake REGISTRY record below.
const TOKEN = "up_default_rendertoken";

beforeAll(() => {
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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** Extends UsageFakeD1 (real workspace_usage ledger) with an optional
 * D1-backed scoped auth token, so scope-enforcement tests can exercise a
 * token with fewer than the full FILE_SCOPES set — the legacy tokenHash path
 * (used by every other test here) always grants all scopes. */
class RenderFakeD1 extends UsageFakeD1 {
  constructor(authToken?: { tokenHash: string; scopes: string }) {
    super();
    const base = this.prepare;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.prepare = ((sql: string): any => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.includes("FROM auth_tokens") && authToken) {
        let args: unknown[] = [];
        const stmt = {
          bind: (...v: unknown[]) => {
            args = v;
            return stmt;
          },
          first: async () => {
            const hash = args[1] as string;
            if (hash === authToken.tokenHash) {
              return {
                id: "token-id",
                workspace: "default",
                token_hash: authToken.tokenHash,
                label: null,
                scopes: authToken.scopes,
                created_at: "2026-07-16T00:00:00.000Z",
                expires_at: null,
                revoked_at: null,
                minting_user_id: null,
              };
            }
            return null;
          },
          all: async () => ({ success: true, results: [] }),
          run: async () => ({ success: true, meta: { changes: 0 }, results: [] }),
        };
        return stmt;
      }
      return base(sql);
    }) as typeof this.prepare;
  }
}

async function makeEnv(
  opts: {
    overrides?: Partial<WorkspaceRecord>;
    browser?: FakeBrowser;
    rateLimitOk?: boolean;
    scopedToken?: { rawToken: string; scopes: string[] };
  } = {},
) {
  const record: WorkspaceRecord = {
    provider: "r2",
    bucket: "uploads-default",
    binding: "UPLOADS_DEFAULT",
    prefix: "default/",
    publicBaseUrl: "https://storage.uploads.sh",
    tokenHash: await sha256Hex(TOKEN),
    ...opts.overrides,
  };
  const db = new RenderFakeD1(
    opts.scopedToken
      ? {
          tokenHash: await sha256Hex(opts.scopedToken.rawToken),
          scopes: JSON.stringify(opts.scopedToken.scopes),
        }
      : undefined,
  );
  const browser = opts.browser ?? FakeBrowser.pngResponse(PNG);
  const env = {
    REGISTRY: { get: async () => record, put: async () => undefined },
    DB: db,
    BROWSER: browser,
    RENDER_LIMITER: { limit: async () => ({ success: opts.rateLimitOk ?? true }) },
  };
  return { env, db, browser };
}

function renderReq(env: unknown, body: unknown, token = TOKEN) {
  return app.request(
    "/v1/render",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env as never,
  );
}

describe("POST /v1/render happy path", () => {
  it("renders a url and returns PNG bytes with the right content-type", async () => {
    const { env, browser } = await makeEnv();
    const res = await renderReq(env, { url: "https://example.com" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...PNG]);
    expect(browser.calls).toHaveLength(1);
    expect(browser.calls[0].action).toBe("screenshot");
    expect(browser.calls[0].options).toMatchObject({ url: "https://example.com" });
  });

  it("renders raw html", async () => {
    const { env, browser } = await makeEnv();
    const res = await renderReq(env, { html: "<!doctype html><h1>hi</h1>" });
    expect(res.status).toBe(200);
    expect(browser.calls[0].options).toMatchObject({ html: "<!doctype html><h1>hi</h1>" });
  });

  it("passes viewport, selector, fullPage and waitUntil through to Browser Run", async () => {
    const { env, browser } = await makeEnv();
    const res = await renderReq(env, {
      url: "https://example.com",
      viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
      selector: "main",
      fullPage: true,
      waitUntil: "networkidle",
    });
    expect(res.status).toBe(200);
    expect(browser.calls[0].options).toMatchObject({
      selector: "main",
      viewport: { width: 1280, height: 800, deviceScaleFactor: 2 },
      screenshotOptions: { type: "png", fullPage: true },
      gotoOptions: { waitUntil: "networkidle2" },
    });
  });

  it('passes waitUntil "domcontentloaded" straight through to Browser Run', async () => {
    const { env, browser } = await makeEnv();
    const res = await renderReq(env, {
      url: "https://example.com",
      waitUntil: "domcontentloaded",
    });
    expect(res.status).toBe(200);
    expect(browser.calls[0].options).toMatchObject({
      gotoOptions: { waitUntil: "domcontentloaded" },
    });
  });

  it("clamps out-of-range viewport and deviceScaleFactor values", async () => {
    const { env, browser } = await makeEnv();
    const res = await renderReq(env, {
      url: "https://example.com",
      viewport: { width: 99999, height: 1, deviceScaleFactor: 10 },
    });
    expect(res.status).toBe(200);
    expect(browser.calls[0].options).toMatchObject({
      viewport: { width: 4096, height: 16, deviceScaleFactor: 3 },
    });
  });

  it("increments uploads_in_period on a successful render (shares the monthly upload budget)", async () => {
    const { env, db } = await makeEnv();
    await renderReq(env, { url: "https://example.com" });
    expect(db.usage.get("default")?.uploads_in_period).toBe(1);
  });
});

describe("POST /v1/render auth + scope", () => {
  it("401s with no bearer token", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/render",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      },
      env as never,
    );
    expect(res.status).toBe(401);
  });

  it("401s an unknown/garbage token", async () => {
    const { env } = await makeEnv();
    const res = await renderReq(env, { url: "https://example.com" }, "up_default_wrong-token");
    expect(res.status).toBe(401);
  });

  it("403s a read-only-scoped token (insufficient_scope), no render performed", async () => {
    const READ_TOKEN = "up_default_readonlytoken";
    const { env, browser } = await makeEnv({
      scopedToken: { rawToken: READ_TOKEN, scopes: ["files:read"] },
    });
    const res = await renderReq(env, { url: "https://example.com" }, READ_TOKEN);
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("insufficient_scope");
    expect(browser.calls).toHaveLength(0);
  });
});

describe("POST /v1/render validation", () => {
  it("rejects a body with neither url nor html", async () => {
    const { env } = await makeEnv();
    const res = await renderReq(env, {});
    expect(res.status).toBe(400);
  });

  it("rejects a body with both url and html", async () => {
    const { env } = await makeEnv();
    const res = await renderReq(env, { url: "https://example.com", html: "<p>x</p>" });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON", async () => {
    const { env } = await makeEnv();
    const res = await app.request(
      "/v1/render",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: "{not json",
      },
      env as never,
    );
    expect(res.status).toBe(400);
  });

  it("rejects an oversized html body with 413 (upload_too_large, from parseRenderRequest's exact 2 MiB field check)", async () => {
    const { env } = await makeEnv();
    const res = await renderReq(env, { html: "x".repeat(2 * 1024 * 1024 + 1) });
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("upload_too_large");
  });

  it("rejects a request body over the outer cap with 413 (payload_too_large, from readJsonObjectBody)", async () => {
    const { env } = await makeEnv();
    // Well past MAX_RENDER_HTML_BYTES + 1 MiB headroom, so readJsonObjectBody's
    // buffered-size check rejects it before parseRenderRequest ever runs.
    const res = await renderReq(env, { html: "x".repeat(4 * 1024 * 1024) });
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("payload_too_large");
  });

  it("rejects a non-http(s) url", async () => {
    const { env } = await makeEnv();
    const res = await renderReq(env, { url: "file:///etc/passwd" });
    expect(res.status).toBe(400);
  });

  it.each([
    "http://localhost/",
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://172.16.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/",
    "http://foo.internal/",
    "http://foo.local/",
    "http://[::1]/",
    "http://0.0.0.0/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[fc00::1]/",
    "http://[fd12::1]/",
    "http://[fe80::1]/",
  ])("rejects a private/internal render target: %s", async (url) => {
    const { env, browser } = await makeEnv();
    const res = await renderReq(env, { url });
    expect(res.status).toBe(400);
    expect(browser.calls).toHaveLength(0);
  });

  it("rejects an invalid colorScheme", async () => {
    const { env } = await makeEnv();
    const res = await renderReq(env, { url: "https://example.com", colorScheme: "blue" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid waitUntil", async () => {
    const { env } = await makeEnv();
    const res = await renderReq(env, { url: "https://example.com", waitUntil: "eventually" });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/render quota + rate limiting", () => {
  it("429s when the burst RENDER_LIMITER denies", async () => {
    const { env, browser } = await makeEnv({ rateLimitOk: false });
    const res = await renderReq(env, { url: "https://example.com" });
    expect(res.status).toBe(429);
    expect(browser.calls).toHaveLength(0);
  });

  it("429s with upload_budget_exceeded once the monthly upload cap is hit, and does not call the renderer", async () => {
    const { env, browser } = await makeEnv({ overrides: { maxUploadsPerPeriod: 1 } });
    const first = await renderReq(env, { url: "https://example.com" });
    expect(first.status).toBe(200);

    const second = await renderReq(env, { url: "https://example.com" });
    expect(second.status).toBe(429);
    const json = (await second.json()) as { error: { code: string } };
    expect(json.error.code).toBe("upload_budget_exceeded");
    expect(browser.calls).toHaveLength(1); // only the first (successful) render
  });
});

describe("POST /v1/render Browser Run error passthrough", () => {
  it("maps a Browser Run 429 to our rate_limited error", async () => {
    const { env, db } = await makeEnv({ browser: FakeBrowser.errorResponse(429) });
    const res = await renderReq(env, { url: "https://example.com" });
    expect(res.status).toBe(429);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("rate_limited");
    // A failed render must not consume the monthly upload budget.
    expect(db.usage.get("default")?.uploads_in_period ?? 0).toBe(0);
  });

  it("maps a Browser Run 422 to a render_failed validation error", async () => {
    const { env } = await makeEnv({ browser: FakeBrowser.errorResponse(422, "bad selector") });
    const res = await renderReq(env, { url: "https://example.com" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { type: string; code: string } };
    expect(json.error.type).toBe("validation");
    expect(json.error.code).toBe("render_failed");
  });

  it("maps a Browser Run 500 to a render_failed service error", async () => {
    const { env } = await makeEnv({ browser: FakeBrowser.errorResponse(500) });
    const res = await renderReq(env, { url: "https://example.com" });
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("render_failed");
  });
});
