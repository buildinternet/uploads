import { describe, expect, it, vi } from "vitest";
import { loadPulls, loaded, normalizeCreateResult, shareInfoFromScope } from "./files-api";

describe("loaded", () => {
  it("unwraps slice 2's ApiResult ok and collapses everything else", () => {
    expect(loaded({ kind: "ok", data: 1 })).toEqual({ ok: true, value: 1 });
    expect(loaded<number>({ kind: "unavailable", reason: "server" })).toEqual({ ok: false });
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
    expect(normalizeCreateResult({ kind: "limit", limit: 50 })).toEqual({ kind: "limit" });
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
