import { describe, expect, it, vi } from "vitest";
import { GH_KEY_RE, planForKey, runBackfill } from "../scripts/backfill-gh-metadata.mjs";

describe("planForKey", () => {
  it("matches a pull-request key and lowercases metadata values only", () => {
    const plan = planForKey("gh/OWNER/REPO/pull/12/screenshot.png");
    expect(plan).toEqual({
      key: "gh/OWNER/REPO/pull/12/screenshot.png",
      metadata: {
        "gh.repo": "owner/repo",
        "gh.kind": "pull",
        "gh.number": "12",
        "gh.ref": "owner/repo#12",
      },
    });
  });

  it("maps the 'issues' path segment to gh.kind 'issue'", () => {
    const plan = planForKey("gh/foo/bar/issues/7/img.png");
    expect(plan).toEqual({
      key: "gh/foo/bar/issues/7/img.png",
      metadata: {
        "gh.repo": "foo/bar",
        "gh.kind": "issue",
        "gh.number": "7",
        "gh.ref": "foo/bar#7",
      },
    });
  });

  it("returns null for keys that don't match the gh/ layout", () => {
    for (const key of [
      "gh/onlytwo/segments",
      "gh/foo/bar/issues/abc/img.png",
      "gh/foo/bar/merge/12/img.png",
      "screenshots/shot.png",
      "gh/foo/bar/pull//img.png",
    ]) {
      expect(planForKey(key)).toBeNull();
    }
  });

  it("keeps the object key's original casing", () => {
    const plan = planForKey("gh/MixedCase/Repo/pull/3/x.png");
    expect(plan?.key).toBe("gh/MixedCase/Repo/pull/3/x.png");
    expect(plan?.metadata["gh.repo"]).toBe("mixedcase/repo");
  });
});

describe("GH_KEY_RE", () => {
  it("matches the anchored gh/<owner>/<repo>/<pull|issues>/<number>/ prefix", () => {
    expect(GH_KEY_RE.test("gh/o/r/pull/1/x")).toBe(true);
    expect(GH_KEY_RE.test("gh/o/r/pull/1/")).toBe(true);
    expect(GH_KEY_RE.test("other/gh/o/r/pull/1/x")).toBe(false);
  });
});

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe("runBackfill", () => {
  const baseOpts = {
    apiUrl: "https://api.example.test",
    workspace: "default",
    token: "tok_123",
  };

  it("paginates the list endpoint and PATCHes each matching key", async () => {
    const calls: { url: string; init?: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      calls.push({ url, init });
      if (url.includes("/files?")) {
        if (url.includes("cursor=page2")) {
          return jsonResponse({
            items: [{ key: "gh/foo/bar/issues/7/img.png" }],
            cursor: null,
          });
        }
        return jsonResponse({
          items: [{ key: "gh/owner/repo/pull/12/a.png" }, { key: "not-gh/whatever" }],
          cursor: "page2",
        });
      }
      if (url.includes("/files/gh/")) {
        return jsonResponse({ metadata: {} });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const summary = await runBackfill({ ...baseOpts, fetchImpl });

    expect(summary).toEqual({ matched: 2, patched: 2, skipped: 1, errors: 0 });

    const listCalls = calls.filter((c) => c.url.includes("/files?"));
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1].url).toContain("cursor=page2");

    const patchCalls = calls.filter((c) => c.url.includes("/files/gh/"));
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[0].url).toContain("gh/owner/repo/pull/12/a.png");
    expect(patchCalls[0].url).not.toContain("/metadata");
    expect(patchCalls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(patchCalls[0].init?.body as string)).toEqual({
      set: {
        "gh.repo": "owner/repo",
        "gh.kind": "pull",
        "gh.number": "12",
        "gh.ref": "owner/repo#12",
      },
    });
    const patchHeaders = patchCalls[0].init?.headers as Record<string, string> | undefined;
    expect(patchHeaders?.Authorization).toBe("Bearer tok_123");
  });

  it("dry-run performs no PATCH requests", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/files?")) {
        return jsonResponse({ items: [{ key: "gh/owner/repo/pull/12/a.png" }], cursor: null });
      }
      throw new Error(`unexpected fetch in dry-run: ${url}`);
    });

    const summary = await runBackfill({ ...baseOpts, dryRun: true, fetchImpl });

    expect(summary).toEqual({ matched: 1, patched: 0, skipped: 0, errors: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("counts a non-2xx PATCH as an error and continues to the next item", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/files?")) {
        return jsonResponse({
          items: [{ key: "gh/owner/repo/pull/12/a.png" }, { key: "gh/owner/repo/pull/13/b.png" }],
          cursor: null,
        });
      }
      if (url.includes("/pull/12/a.png")) {
        return jsonResponse({ error: "boom" }, 500);
      }
      if (url.includes("/pull/13/b.png")) {
        return jsonResponse({ metadata: {} });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const summary = await runBackfill({ ...baseOpts, fetchImpl });

    expect(summary).toEqual({ matched: 2, patched: 1, skipped: 0, errors: 1 });
  });

  it("counts a thrown PATCH fetch (transport error) as an error and continues", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/files?")) {
        return jsonResponse({
          items: [{ key: "gh/owner/repo/pull/12/a.png" }, { key: "gh/owner/repo/pull/13/b.png" }],
          cursor: null,
        });
      }
      if (url.includes("/pull/12/a.png")) {
        throw new TypeError("fetch failed: connection reset");
      }
      if (url.includes("/pull/13/b.png")) {
        return jsonResponse({ metadata: {} });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const summary = await runBackfill({ ...baseOpts, fetchImpl });

    expect(summary).toEqual({ matched: 2, patched: 1, skipped: 0, errors: 1 });
    // Both PATCHes were attempted despite the first one throwing.
    expect(fetchImpl.mock.calls.filter(([url]) => url.includes("/files/gh/"))).toHaveLength(2);
  });

  it("aborts cleanly with an error counted when the list fetch throws (transport error)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND");
    });

    const summary = await runBackfill({ ...baseOpts, fetchImpl });

    expect(summary).toEqual({ matched: 0, patched: 0, skipped: 0, errors: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
