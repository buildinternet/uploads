import { describe, expect, it, vi } from "vitest";
import { createPageCache } from "./item-page-cache";

describe("createPageCache", () => {
  it("loads once while fresh and again after 30s", async () => {
    let t = 0;
    const load = vi.fn(async (href: string) => `<p>${href}</p>`);
    const cache = createPageCache(load, () => t);
    expect(cache.peek("/a")).toBeNull();
    await cache.warm("/a");
    await cache.warm("/a");
    expect(load).toHaveBeenCalledTimes(1);
    expect(await cache.peek("/a")).toBe("<p>/a</p>");
    t = 30_000;
    expect(cache.peek("/a")).toBeNull();
    await cache.warm("/a");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("turns a failed load into null", async () => {
    const cache = createPageCache(() => Promise.reject(new Error("offline")));
    expect(await cache.warm("/a")).toBeNull();
  });

  it("keeps at most 12 pages", async () => {
    const cache = createPageCache(async (href) => href);
    for (let i = 0; i < 13; i++) await cache.warm(`/${i}`);
    expect(cache.peek("/0")).toBeNull();
    expect(await cache.peek("/12")).toBe("/12");
  });
});
