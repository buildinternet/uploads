import { afterEach, describe, expect, it, vi } from "vitest";

const resolveTitles = vi.fn();
vi.mock("./github-titles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-titles")>()),
  resolveTitles: (...args: unknown[]) => resolveTitles(...args),
}));

const { publicFeedGithub } = await import("./feed-github");

const env = {} as Env;

afterEach(() => resolveTitles.mockReset());

describe("publicFeedGithub", () => {
  it("resolves the PR title with the public audience only", async () => {
    resolveTitles.mockResolvedValue({ "acme/web#12": { title: " Fix nav ", state: "merged" } });
    expect(await publicFeedGithub(env, { repo: "Acme/Web", number: 12 })).toEqual({
      title: "Fix nav",
      state: "merged",
    });
    expect(resolveTitles).toHaveBeenCalledWith(
      env,
      ["acme/web#12"],
      { audience: "public" },
      undefined,
    );
  });

  it("returns nulls for a private or unknown repo (no stamped fallback)", async () => {
    resolveTitles.mockResolvedValue({ "acme/web#12": null });
    expect(await publicFeedGithub(env, { repo: "acme/web", number: 12 })).toEqual({
      title: null,
      state: null,
    });
  });

  it("returns nulls when resolution throws", async () => {
    resolveTitles.mockRejectedValue(new Error("boom"));
    expect(await publicFeedGithub(env, { repo: "acme/web", number: 12 })).toEqual({
      title: null,
      state: null,
    });
  });

  it("returns null for a repo-wide live link without calling the resolver", async () => {
    expect(await publicFeedGithub(env, { repo: "acme/web", number: 0 })).toBeNull();
    expect(resolveTitles).not.toHaveBeenCalled();
  });
});
