import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { withPublicReadTiming } from "../src/public-read-timing";
import type { WorkspaceVars } from "../src/workspace";

describe("public read timing", () => {
  const app = new Hono<WorkspaceVars>()
    .onError((_error, c) => c.json({ error: "unavailable" }, 503))
    .get("/:phase", (c) =>
      withPublicReadTiming(c, "/:phase", "read_api", async (measure) => {
        c.header("Server-Timing", "prior;dur=1");
        return measure(c.req.param("phase"), async () => {
          if (c.req.param("phase") === "failed") throw new Error("failed");
          return c.json({ ok: true });
        });
      }),
    );

  it("appends timings and keeps collectors isolated between requests", async () => {
    const [first, second] = await Promise.all([
      app.request("/alpha", {}, {}),
      app.request("/beta", {}, {}),
    ]);
    expect(first.headers.get("Server-Timing")).toMatch(/prior;dur=1.*alpha;dur=.*read_api;dur=/);
    expect(first.headers.get("Server-Timing")).not.toContain("beta");
    expect(second.headers.get("Server-Timing")).toContain("beta;dur=");
    expect(second.headers.get("Server-Timing")).not.toContain("alpha");
    expect(await first.json()).toEqual({ ok: true });
  });

  it("honors the disabled switch without changing the response", async () => {
    const response = await app.request("/alpha", {}, { SERVER_TIMING_DISABLED: "1" });
    expect(response.headers.get("Server-Timing")).toBe("prior;dur=1");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("records failed operations and preserves the error handler", async () => {
    const response = await app.request("/failed", {}, {});
    expect(response.status).toBe(503);
    expect(response.headers.get("Server-Timing")).toContain("failed;dur=");
    expect(response.headers.get("Server-Timing")).toContain("read_api;dur=");
  });
});
