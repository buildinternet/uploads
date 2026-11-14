import type { McpTool } from "@buildinternet/uploads/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __setEnterSpan } from "../../../packages/observability/src/cloudflare-workers-stub";
import { traceTools } from "../src/tool-spans";

afterEach(() => __setEnterSpan("default"));

describe("traceTools", () => {
  it("runs each handler in a tools/call span named after the tool", async () => {
    const span = { setAttributes: vi.fn(), recordException: vi.fn(), setStatus: vi.fn() };
    const names: string[] = [];
    __setEnterSpan((name, cb) => {
      names.push(name);
      return cb(span);
    });
    const handler = vi.fn(async () => ({ ok: true }));
    const [tool] = traceTools([{ name: "put", handler } as unknown as McpTool]);
    await expect(tool!.handler({ filename: "a.png" })).resolves.toEqual({ ok: true });
    expect(handler).toHaveBeenCalledWith({ filename: "a.png" });
    expect(names).toEqual(["tools/call put"]);
    expect(span.setAttributes).toHaveBeenCalledWith({
      "mcp.method.name": "tools/call",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "put",
    });
  });

  it("records a failed call and rethrows for the server's isError result", async () => {
    const span = { setAttributes: vi.fn(), recordException: vi.fn(), setStatus: vi.fn() };
    __setEnterSpan((_name, cb) => cb(span));
    const err = new Error("no such file");
    const [tool] = traceTools([
      {
        name: "delete",
        handler: async () => {
          throw err;
        },
      } as unknown as McpTool,
    ]);
    await expect(tool!.handler({})).rejects.toBe(err);
    expect(span.recordException).toHaveBeenCalledWith(err);
  });
});
