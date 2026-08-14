import { describe, expect, it, vi } from "vitest";
import { respondWebFetchFailure } from "./web-fetch-error";

describe("respondWebFetchFailure", () => {
  it("returns the branded 500 page for HTML navigations", async () => {
    const assets = {
      fetch: vi.fn(async () => new Response("<html>500</html>", { status: 200 })),
    };
    const res = await respondWebFetchFailure(
      new Request("https://uploads.sh/account", {
        headers: { accept: "text/html,application/xhtml+xml" },
      }),
      assets,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("<html>500</html>");
    expect(assets.fetch).toHaveBeenCalledOnce();
  });

  it("does not recurse when /500 itself fails", async () => {
    const assets = {
      fetch: vi.fn(async () => {
        throw new Error("assets down");
      }),
    };
    const res = await respondWebFetchFailure(
      new Request("https://uploads.sh/500", { headers: { accept: "text/html" } }),
      assets,
    );
    expect(assets.fetch).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });

  it("returns plain text when the client is not asking for HTML", async () => {
    const assets = { fetch: vi.fn() };
    const res = await respondWebFetchFailure(
      new Request("https://uploads.sh/openapi.json", {
        headers: { accept: "application/json" },
      }),
      assets,
    );
    expect(assets.fetch).not.toHaveBeenCalled();
    expect(res.headers.get("content-type")).toContain("text/plain");
  });
});
