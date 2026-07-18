import { describe, expect, it } from "vitest";
import { orderOrgsOldestFirst, safeSameOriginPath } from "./workspace-ui";

describe("safeSameOriginPath", () => {
  it("accepts an absolute in-app path with query and hash", () => {
    expect(safeSameOriginPath("/oauth/consent?client_id=c1&sig=x#top")).toBe(
      "/oauth/consent?client_id=c1&sig=x#top",
    );
  });

  it("rejects everything that could navigate off-origin", () => {
    expect(safeSameOriginPath(undefined)).toBeNull();
    expect(safeSameOriginPath("")).toBeNull();
    expect(safeSameOriginPath("relative/path")).toBeNull();
    expect(safeSameOriginPath("https://evil.example/x")).toBeNull();
    // Protocol-relative and the backslash variant browsers normalize to it.
    expect(safeSameOriginPath("//evil.example")).toBeNull();
    expect(safeSameOriginPath("/\\evil.example")).toBeNull();
    // Defense in depth: a raw embedded scheme is rejected even inside the
    // query — legitimate producers percent-encode (the consent page does).
    expect(safeSameOriginPath("/ok?u=https://evil.example")).toBeNull();
  });
});

describe("orderOrgsOldestFirst", () => {
  it("orders by createdAt ascending (oldest first)", () => {
    const orgs = [
      { slug: "newest", createdAt: "2026-03-01T00:00:00Z" },
      { slug: "oldest", createdAt: "2024-01-01T00:00:00Z" },
      { slug: "middle", createdAt: "2025-02-01T00:00:00Z" },
    ];
    expect(orderOrgsOldestFirst(orgs).map((o) => o.slug)).toEqual(["oldest", "middle", "newest"]);
  });

  it("accepts Date instances alongside strings", () => {
    const orgs = [
      { slug: "b", createdAt: new Date("2026-01-01T00:00:00Z") },
      { slug: "a", createdAt: new Date("2020-01-01T00:00:00Z") },
    ];
    expect(orderOrgsOldestFirst(orgs).map((o) => o.slug)).toEqual(["a", "b"]);
  });

  it("keeps given relative order for entries without createdAt (stable)", () => {
    const orgs = [{ slug: "first" }, { slug: "second" }, { slug: "third" }];
    expect(orderOrgsOldestFirst(orgs).map((o) => o.slug)).toEqual(["first", "second", "third"]);
  });

  it("sorts dated entries before undated entries regardless of input order", () => {
    const orgs = [{ slug: "undated" }, { slug: "dated", createdAt: "2026-01-01T00:00:00Z" }];
    expect(orderOrgsOldestFirst(orgs).map((o) => o.slug)).toEqual(["dated", "undated"]);
  });

  it("tolerates an unparseable createdAt string as if undated", () => {
    const orgs = [
      { slug: "bad", createdAt: "not-a-date" },
      { slug: "good", createdAt: "2026-01-01T00:00:00Z" },
    ];
    expect(orderOrgsOldestFirst(orgs).map((o) => o.slug)).toEqual(["good", "bad"]);
  });

  it("does not mutate the input array", () => {
    const orgs = [
      { slug: "b", createdAt: "2026-01-01T00:00:00Z" },
      { slug: "a", createdAt: "2020-01-01T00:00:00Z" },
    ];
    const copy = [...orgs];
    orderOrgsOldestFirst(orgs);
    expect(orgs).toEqual(copy);
  });
});
