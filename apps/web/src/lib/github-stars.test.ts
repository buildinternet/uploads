import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatStars, githubStarCount, resetStarCountMemo } from "./github-stars";

const OK = (stargazers_count: unknown) =>
  ({ ok: true, json: async () => ({ stargazers_count }) }) as unknown as Response;

describe("formatStars", () => {
  it("abbreviates thousands and leaves smaller counts alone", () => {
    expect(formatStars(0)).toBe("0");
    expect(formatStars(999)).toBe("999");
    expect(formatStars(1000)).toBe("1.0k");
    expect(formatStars(12_345)).toBe("12.3k");
  });
});

describe("githubStarCount", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetStarCountMemo();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns the count and sends a User-Agent (GitHub 403s without one)", async () => {
    fetchMock.mockResolvedValue(OK(14));
    await expect(githubStarCount()).resolves.toBe(14);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers["user-agent"]).toBeTruthy();
  });

  it("memoizes within the hour instead of refetching per render", async () => {
    fetchMock.mockResolvedValue(OK(14));
    const start = 1_000_000;
    await githubStarCount(start);
    await githubStarCount(start + 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await githubStarCount(start + 3_600_001);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null rather than throwing when the request fails", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));
    await expect(githubStarCount()).resolves.toBeNull();
  });

  it("returns null on a non-ok response or a junk payload", async () => {
    fetchMock.mockResolvedValue({ ok: false } as Response);
    await expect(githubStarCount()).resolves.toBeNull();

    resetStarCountMemo();
    fetchMock.mockResolvedValue(OK("lots"));
    await expect(githubStarCount()).resolves.toBeNull();
  });

  it("keeps serving the last good count through a later failure", async () => {
    const start = 1_000_000;
    fetchMock.mockResolvedValue(OK(14));
    await githubStarCount(start);

    // An hour later the memo is stale and the refetch fails: the header should
    // keep the known number rather than blanking out.
    fetchMock.mockRejectedValue(new Error("rate limited"));
    await expect(githubStarCount(start + 3_600_001)).resolves.toBe(14);
  });

  it("retries a failure sooner than an hour", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const start = 1_000_000;
    await expect(githubStarCount(start)).resolves.toBeNull();

    await githubStarCount(start + 30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still inside the failure TTL

    fetchMock.mockResolvedValue(OK(14));
    await expect(githubStarCount(start + 61_000)).resolves.toBe(14);
  });
});
