import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUploadsClient } from "../src/client.js";
import { UploadsError } from "../src/errors.js";
import { fileExpiredTokenStore, tokenExpiryWarner } from "../src/expired-tokens.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uploads-expired-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function expiredResponse() {
  return new Response(
    JSON.stringify({
      error: {
        type: "unauthorized",
        code: "token_expired",
        message: "This token expired on 2026-10-19.",
        details: { expires_at: "2026-10-19T15:52:43.202Z" },
      },
    }),
    { status: 401 },
  );
}

function client(token: string, path: string) {
  return createUploadsClient(
    { apiUrl: "https://api.test", workspace: "test", token },
    { expiredTokens: fileExpiredTokenStore(path) },
  );
}

async function failure(p: Promise<unknown>): Promise<UploadsError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UploadsError);
  return err as UploadsError;
}

describe("expired token memory", () => {
  it("stops sending a token after the server calls it expired", async () => {
    const fetchMock = vi.fn(async () => expiredResponse());
    vi.stubGlobal("fetch", fetchMock);
    const path = join(dir, "expired-tokens.json");

    const first = await failure(client("up_test_dead", path).list({ limit: 1 }));
    expect(first.code).toBe("UNAUTHORIZED");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A new client (a new CLI process) reads the marker and never calls out.
    const second = await failure(client("up_test_dead", path).list({ limit: 1 }));
    expect(second.code).toBe("UNAUTHORIZED");
    expect(second.message).toBe("This token expired on 2026-10-19.");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(readFileSync(path, "utf8")).not.toContain("up_test_dead");
  });

  it("still sends a different token", async () => {
    const path = join(dir, "expired-tokens.json");
    fileExpiredTokenStore(path).remember("up_test_dead", "This token expired on 2026-10-19.");
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ files: [], cursor: null }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await client("up_test_new", path).list({ limit: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not remember a plain 401", async () => {
    const path = join(dir, "expired-tokens.json");
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "unauthorized", message: "unauthorized" } }), {
          status: 401,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await failure(client("up_test_revoked", path).list({ limit: 1 }));
    await failure(client("up_test_revoked", path).list({ limit: 1 }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("token expiry warning", () => {
  const NOW = new Date("2026-10-22T12:00:00Z");

  function warned(expiresAt: string | null, path = join(dir, "warned")) {
    const lines: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ files: [], cursor: null }), {
            status: 200,
            headers: expiresAt ? { "Uploads-Token-Expires": expiresAt } : {},
          }),
      ),
    );
    const c = createUploadsClient(
      { apiUrl: "https://api.test", workspace: "test", token: "up_test_live" },
      {
        onTokenExpiry: tokenExpiryWarner(
          path,
          (line) => lines.push(line),
          () => NOW,
        ),
      },
    );
    return { c, lines };
  }

  it("warns once when the token expires within a week", async () => {
    const { c, lines } = warned("2026-10-27T09:00:00.000Z");
    await c.list({ limit: 1 });
    await c.list({ limit: 1 });
    expect(lines).toEqual([
      "uploads: your login expires in 5 days (2026-10-27). Run `uploads login --force` to renew it.\n",
    ]);

    // A later run the same day stays quiet.
    const again = warned("2026-10-27T09:00:00.000Z");
    await again.c.list({ limit: 1 });
    expect(again.lines).toEqual([]);
  });

  it("stays quiet further out, or without the header", async () => {
    const far = warned("2026-12-01T00:00:00.000Z");
    await far.c.list({ limit: 1 });
    const none = warned(null);
    await none.c.list({ limit: 1 });
    expect([...far.lines, ...none.lines]).toEqual([]);
  });
});
