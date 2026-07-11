import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/index";
import { sha256Hex, type WorkspaceRecord } from "../src/workspace";

const workspace: WorkspaceRecord = { provider: "r2", bucket: "test" };

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

function env(
  options: {
    legacyHash?: string;
    d1?: {
      tokenHash: string;
      scopes: string;
      expiresAt?: string | null;
      revokedAt?: string | null;
    };
  } = {},
) {
  const record = options.legacyHash ? { ...workspace, tokenHash: options.legacyHash } : workspace;
  return {
    ADMIN_TOKEN: "admin-secret",
    REGISTRY: {
      get: async () => record,
      put: async () => undefined,
    },
    DB: {
      prepare: () => {
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) {
            values = next;
            return this;
          },
          async first() {
            const [, hash, now] = values as string[];
            const token = options.d1;
            if (
              token &&
              token.tokenHash === hash &&
              token.revokedAt == null &&
              (token.expiresAt == null || token.expiresAt > now)
            ) {
              return {
                id: "token-id",
                workspace: "default",
                token_hash: token.tokenHash,
                label: null,
                scopes: token.scopes,
                created_at: "2026-07-10T00:00:00.000Z",
                expires_at: token.expiresAt ?? null,
                revoked_at: token.revokedAt ?? null,
              };
            }
            return null;
          },
        };
      },
    },
  } as unknown as Env;
}

describe("auth routes", () => {
  it("requires administrator authentication for enrollment creation", async () => {
    const response = await app.request(
      "/admin/enrollments",
      { method: "POST", body: JSON.stringify({}) },
      env(),
    );
    expect(response.status).toBe(401);
  });

  it("validates enrollment input and marks every response no-store", async () => {
    const response = await app.request(
      "/admin/enrollments",
      {
        method: "POST",
        headers: { Authorization: "Bearer admin-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ label: "x".repeat(101) }),
      },
      env(),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("uses one uniform, non-cacheable public exchange error", async () => {
    const responses = await Promise.all([
      app.request("/auth/enrollments/exchange", { method: "POST", body: "{}" }, env()),
      app.request(
        "/auth/enrollments/exchange",
        { method: "POST", body: JSON.stringify({ code: "upe_bad" }) },
        env(),
      ),
      app.request(
        "/auth/enrollments/exchange",
        {
          method: "POST",
          body: JSON.stringify({ code: `upe_${"a".repeat(24)}`, extra: true }),
        },
        env(),
      ),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(
      responses.every((response) => response.headers.get("Cache-Control") === "no-store"),
    ).toBe(true);
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
  });

  it("keeps legacy KV credentials fully scoped", async () => {
    const token = "legacy-token";
    const response = await app.request(
      "/v1/default/files/bad%20key",
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      env({ legacyHash: await sha256Hex(token) }),
    );
    expect(response.status).toBe(400);
  });

  it("allows D1 read/write credentials but denies delete", async () => {
    const token = "up_default_scoped-token-value";
    const bindings = env({
      d1: {
        tokenHash: await sha256Hex(token),
        scopes: JSON.stringify(["files:read", "files:write"]),
      },
    });
    const read = await app.request(
      "/v1/default/files/bad%20key",
      { headers: { Authorization: `Bearer ${token}` } },
      bindings,
    );
    const remove = await app.request(
      "/v1/default/files/bad%20key",
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      bindings,
    );
    expect(read.status).toBe(400);
    expect(remove.status).toBe(403);
  });

  it("rejects expired and revoked D1 credentials", async () => {
    const token = "up_default_expired-token-value";
    const tokenHash = await sha256Hex(token);
    const [expired, revoked] = await Promise.all([
      app.request(
        "/v1/default/files/bad%20key",
        { headers: { Authorization: `Bearer ${token}` } },
        env({ d1: { tokenHash, scopes: JSON.stringify(["files:read"]), expiresAt: "2000-01-01" } }),
      ),
      app.request(
        "/v1/default/files/bad%20key",
        { headers: { Authorization: `Bearer ${token}` } },
        env({ d1: { tokenHash, scopes: JSON.stringify(["files:read"]), revokedAt: "2026-01-01" } }),
      ),
    ]);
    expect([expired.status, revoked.status]).toEqual([401, 401]);
  });
});
