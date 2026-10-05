import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspaceFeed,
  deleteWorkspaceFeed,
  fetchPulls,
  fetchRepos,
  fetchScopeFiles,
  listWorkspaceFeeds,
} from "./api-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Response) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const FEED_ID = "feed_AAAAAAAAAAAAAAAAAAAAAA";

const thumb = {
  key: "gh/acme/web/pull/12/home.png",
  kind: "screenshot",
  url: "https://storage.uploads.sh/acme/gh/acme/web/pull/12/home.png",
  embedUrl: "https://embed.uploads.sh/acme/gh/acme/web/pull/12/home.png",
  posterUrl: null,
  status: "available",
};

const pullRow = {
  ref: "acme/web#12",
  repo: "acme/web",
  number: 12,
  branch: "fix-nav",
  title: "Fix nav",
  state: "open",
  lastMediaAt: "2026-10-04T10:00:00.000Z",
  thumbnails: [thumb],
};

const repoRow = {
  repo: "acme/web",
  lastUpdatedAt: "2026-10-04T10:00:00.000Z",
  openPullCount: 2,
  thumbnails: [thumb],
};

const feedItem = {
  id: "0123456789abcdef0123456789abcdef",
  objectKey: "gh/acme/web/pull/12/home.png",
  filename: "home.png",
  status: "available",
  url: thumb.url,
  embedUrl: thumb.embedUrl,
  pageUrl: `https://uploads.sh/c/${FEED_ID}/0123456789abcdef0123456789abcdef`,
  contentType: "image/png",
  size: 1234,
  uploaded: "2026-10-04T10:00:00.000Z",
  modified: null,
  path: "/settings",
  state: null,
};

const ownerFeed = {
  id: FEED_ID,
  url: `https://uploads.sh/c/${FEED_ID}`,
  workspace: "acme",
  repo: "acme/web",
  path: null,
  number: 12,
  kind: "pull",
  title: "acme/web#12",
  createdAt: "2026-10-04T10:00:00.000Z",
  updatedAt: "2026-10-04T10:00:00.000Z",
  source: "user",
};

describe("fetchPulls", () => {
  it("GETs /pulls with only the set query params and parses rows", async () => {
    const fetchMock = stubFetch(
      Response.json({ workspace: "acme", pulls: [pullRow], nextCursor: "c2" }),
    );
    const result = await fetchPulls("/api", "acme", { state: "open", cursor: "c1" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/workspaces/acme/pulls?state=open&cursor=c1");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: "include",
      cache: "no-store",
    });
    expect(result).toEqual({
      kind: "ok",
      data: { workspace: "acme", pulls: [pullRow], nextCursor: "c2" },
    });
  });

  it("sends type (thumbnails filter) and the SSR cookie through opts", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ workspace: "acme", pulls: [], nextCursor: null }),
    );
    await fetchPulls(
      "/api",
      "acme",
      { repo: "acme/web", type: "video" },
      { cookie: "session=1", fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "/api/v1/workspaces/acme/pulls?repo=acme%2Fweb&type=video",
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ headers: { cookie: "session=1" } });
  });

  it("drops an unknown state to null instead of failing the page", async () => {
    stubFetch(
      Response.json({
        workspace: "acme",
        pulls: [{ ...pullRow, state: "draft" }],
        nextCursor: null,
      }),
    );
    const result = await fetchPulls("/api", "acme");
    expect(result.kind === "ok" && result.data.pulls[0]?.state).toBeNull();
  });

  it("reports a wrong-typed row as malformed", async () => {
    stubFetch(
      Response.json({ workspace: "acme", pulls: [{ ...pullRow, number: "12" }], nextCursor: null }),
    );
    expect(await fetchPulls("/api", "acme")).toEqual({ kind: "unavailable", reason: "malformed" });
  });

  it("maps 403 to forbidden and a thrown fetch to network", async () => {
    stubFetch(new Response(null, { status: 403 }));
    expect(await fetchPulls("/api", "acme")).toEqual({ kind: "unavailable", reason: "forbidden" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    expect(await fetchPulls("/api", "acme")).toEqual({ kind: "unavailable", reason: "network" });
  });
});

describe("fetchRepos", () => {
  it("GETs /repos with type and a cursor and parses rows", async () => {
    const fetchMock = stubFetch(
      Response.json({ workspace: "acme", repos: [repoRow], nextCursor: null }),
    );
    const result = await fetchRepos("/api", "acme", { type: "other", cursor: "c1" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/workspaces/acme/repos?type=other&cursor=c1");
    expect(result).toEqual({
      kind: "ok",
      data: { workspace: "acme", repos: [repoRow], nextCursor: null },
    });
  });
});

describe("fetchScopeFiles", () => {
  const scopeBody = {
    repo: "acme/web",
    number: 12,
    items: [feedItem],
    nextCursor: null,
    privateCount: 2,
    liveLink: { id: FEED_ID, url: `https://uploads.sh/c/${FEED_ID}`, source: "comment" },
    pull: { branch: "fix-nav", title: "Fix nav", state: "open" },
  };

  it("lowercases the repo and keeps dots, dashes, and underscores in the path", async () => {
    const fetchMock = stubFetch(Response.json(scopeBody));
    await fetchScopeFiles("/api", "acme", {
      repo: "Foo.Bar/My-Repo_x",
      number: 12,
      type: "screenshot",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/workspaces/acme/scope/foo.bar/my-repo_x/files?number=12&type=screenshot",
    );
  });

  it("parses items, privateCount, the live link, and the PR header", async () => {
    stubFetch(Response.json(scopeBody));
    expect(await fetchScopeFiles("/api", "acme", { repo: "acme/web", number: 12 })).toEqual({
      kind: "ok",
      data: scopeBody,
    });
  });

  it("accepts a null privateCount (cursor pages, or past the probe cap) and a null pull (repo scope)", async () => {
    stubFetch(Response.json({ ...scopeBody, number: null, privateCount: null, pull: null }));
    const result = await fetchScopeFiles("/api", "acme", { repo: "acme/web", cursor: "c2" });
    expect(result.kind === "ok" && [result.data.privateCount, result.data.pull]).toEqual([
      null,
      null,
    ]);
  });

  it("reads a live link from an older API without source as source null, and a missing pull as null", async () => {
    const { pull: _omit, ...older } = scopeBody;
    stubFetch(
      Response.json({
        ...older,
        liveLink: { id: FEED_ID, url: `https://uploads.sh/c/${FEED_ID}` },
      }),
    );
    const result = await fetchScopeFiles("/api", "acme", { repo: "acme/web" });
    expect(result.kind === "ok" && result.data.liveLink?.source).toBeNull();
    expect(result.kind === "ok" && result.data.pull).toBeNull();
  });

  it("refuses a repo without owner/name before fetching", async () => {
    const fetchMock = stubFetch(Response.json(scopeBody));
    expect(await fetchScopeFiles("/api", "acme", { repo: "acme" })).toEqual({
      kind: "unavailable",
      reason: "invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("listWorkspaceFeeds", () => {
  it("GETs /feeds and reads a missing source as null", async () => {
    const { source: _omit, ...legacy } = ownerFeed;
    const fetchMock = stubFetch(Response.json({ feeds: [ownerFeed, legacy], nextCursor: "n" }));
    const result = await listWorkspaceFeeds("/api", "acme", "c1");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/workspaces/acme/feeds?cursor=c1");
    expect(result).toEqual({
      kind: "ok",
      data: { feeds: [ownerFeed, { ...legacy, source: null }], nextCursor: "n" },
    });
  });
});

describe("createWorkspaceFeed", () => {
  it("POSTs { repo, pr } and keeps the summary fields of the created feed", async () => {
    const fetchMock = stubFetch(
      Response.json({ ...ownerFeed, items: [feedItem] }, { status: 201 }),
    );
    const result = await createWorkspaceFeed("/api", "acme", { repo: "acme/web", pr: 12 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/workspaces/acme/feeds");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ repo: "acme/web", pr: 12 }));
    expect(result).toEqual({ kind: "ok", data: ownerFeed });
  });

  it("sends a repo-only body for a repo live link", async () => {
    const fetchMock = stubFetch(Response.json({ ...ownerFeed, number: null, items: [] }));
    await createWorkspaceFeed("/api", "acme", { repo: "acme/web" });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ repo: "acme/web" }));
  });

  it("returns the cap as kind limit with the API's limit", async () => {
    stubFetch(
      Response.json(
        {
          error: {
            code: "feed_limit_reached",
            type: "conflict",
            message: "Feed limit reached.",
            details: { limit: 50 },
          },
        },
        { status: 409 },
      ),
    );
    expect(await createWorkspaceFeed("/api", "acme", { repo: "acme/web" })).toEqual({
      kind: "limit",
      limit: 50,
    });
  });

  it("maps 400 to invalid", async () => {
    stubFetch(new Response(null, { status: 400 }));
    expect(await createWorkspaceFeed("/api", "acme", { repo: "bad" })).toEqual({
      kind: "unavailable",
      reason: "invalid",
    });
  });
});

describe("deleteWorkspaceFeed", () => {
  it("DELETEs the feed and maps 404 to not_found", async () => {
    const fetchMock = stubFetch(Response.json({ deleted: true, id: FEED_ID }));
    expect(await deleteWorkspaceFeed("/api", "acme", FEED_ID)).toEqual({
      kind: "ok",
      data: undefined,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/workspaces/acme/feeds/${FEED_ID}`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
    stubFetch(new Response(null, { status: 404 }));
    expect(await deleteWorkspaceFeed("/api", "acme", FEED_ID)).toEqual({
      kind: "unavailable",
      reason: "not_found",
    });
  });
});
