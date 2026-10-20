import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUploadsClient } from "../src/client.js";
import { UploadsError } from "../src/errors.js";
import { fileExpiredTokenStore } from "../src/expired-tokens.js";

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
