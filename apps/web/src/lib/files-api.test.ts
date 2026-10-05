import { describe, expect, it, vi } from "vitest";
import {
  isNotPubliclyServed,
  loadPulls,
  loadScopeFiles,
  loaded,
  normalizeCreateResult,
  shareInfoFromScope,
} from "./files-api";

describe("loaded", () => {
  it("unwraps slice 2's ApiResult ok and keeps the failure reason", () => {
    expect(loaded({ kind: "ok", data: 1 })).toEqual({ ok: true, value: 1 });
    expect(loaded<number>({ kind: "unavailable", reason: "server" })).toEqual({
      ok: false,
      reason: "server",
    });
  });
});

describe("isNotPubliclyServed", () => {
  it("is true only for the not_public failure", () => {
    expect(isNotPubliclyServed({ ok: false, reason: "not_public" })).toBe(true);
    expect(isNotPubliclyServed({ ok: false, reason: "server" })).toBe(false);
    expect(isNotPubliclyServed({ ok: false })).toBe(false);
    expect(isNotPubliclyServed({ ok: true, value: null })).toBe(false);
  });
});

describe("loadScopeFiles", () => {
  it("keeps the not_public reason from the #1079 503", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          error: { code: "feed_object_not_public", message: "Feed object is not publicly served." },
        },
        { status: 503 },
      ),
    );
    const result = await loadScopeFiles(
      "/api",
      "acme",
      { repo: "acme/web", number: 7, type: null },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual({ ok: false, reason: "not_public" });
    expect(isNotPubliclyServed(result)).toBe(true);
  });

  it("reads any other 503 as a retryable server failure", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: { code: "d1_unavailable" } }, { status: 503 }),
    );
    const result = await loadScopeFiles(
      "/api",
      "acme",
      { repo: "acme/web", number: null, type: null },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result).toEqual({ ok: false, reason: "server" });
  });
});

describe("loadPulls", () => {
  it("sends all=1 only when older pull requests are requested", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ workspace: "acme", pulls: [], nextCursor: null }),
    );
    const opts = { fetchImpl: fetchImpl as unknown as typeof fetch };
    const q = { type: null, repo: "", state: null };
    await loadPulls("/api", "acme", q, opts);
    await loadPulls("/api", "acme", { ...q, all: false }, opts);
    await loadPulls("/api", "acme", { ...q, all: true }, opts);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "/api/v1/workspaces/acme/pulls",
      "/api/v1/workspaces/acme/pulls",
      "/api/v1/workspaces/acme/pulls?all=1",
    ]);
  });
});

describe("normalizeCreateResult", () => {
  it("maps ok, cap, and failure", () => {
    expect(
      normalizeCreateResult({
        kind: "ok",
        data: { id: "abc", url: "https://uploads.sh/c/abc" },
      } as never),
    ).toEqual({ kind: "ok", id: "abc", url: "https://uploads.sh/c/abc" });
    expect(normalizeCreateResult({ kind: "limit", limit: 50 })).toEqual({
      kind: "limit",
      limit: 50,
    });
    expect(normalizeCreateResult({ kind: "unavailable", reason: "server" })).toEqual({
      kind: "error",
    });
  });
});

describe("shareInfoFromScope", () => {
  it("keeps privateCount and the live link id/url only", () => {
    expect(
      shareInfoFromScope({
        privateCount: 2,
        liveLink: { id: "abc", url: "https://uploads.sh/c/abc", source: "comment" },
      }),
    ).toEqual({ privateCount: 2, liveLink: { id: "abc", url: "https://uploads.sh/c/abc" } });
    expect(shareInfoFromScope({ privateCount: null, liveLink: null })).toEqual({
      privateCount: null,
      liveLink: null,
    });
  });
});
