import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setIssueSpan } from "../../../packages/observability/src/cloudflare-workers-stub";
import { traceRoute } from "./trace-route";

afterEach(() => __setIssueSpan(undefined));

describe("traceRoute", () => {
  it("names the root span after the matched route, not the URL", async () => {
    const updateName = vi.fn();
    __setIssueSpan({ setAttribute: vi.fn(), updateName });
    const sub = new Hono().get("/:workspace/files/:key{.+}", (c) => c.text("ok"));
    const app = new Hono().use("*", traceRoute).route("/v1/workspaces", sub);
    const res = await app.request("/v1/workspaces/acme/files/secret-name.png");
    expect(res.status).toBe(200);
    expect(updateName).toHaveBeenCalledWith("GET /v1/workspaces/:workspace/files/:key{.+}");
  });
});
