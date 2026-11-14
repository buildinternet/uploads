import { afterEach, describe, expect, it, vi } from "vitest";
import { __setEnterSpan, __setIssueSpan, __setIssueSpanExplode } from "./cloudflare-workers-stub";
import { annotateSpan, nameActiveSpan, withSpan } from "./tracing";

afterEach(() => {
  __setEnterSpan("default");
  __setIssueSpan(undefined);
  __setIssueSpanExplode(false);
});

function recorder() {
  const span = {
    setAttributes: vi.fn(),
    recordException: vi.fn(),
    setStatus: vi.fn(),
  };
  const names: string[] = [];
  __setEnterSpan((name, callback) => {
    names.push(name);
    return callback(span);
  });
  return { span, names };
}

describe("withSpan", () => {
  it("runs the work when the runtime has no enterSpan", async () => {
    __setEnterSpan(undefined);
    await expect(withSpan("uploads.x", { a: 1 }, async () => "ok")).resolves.toBe("ok");
  });

  it("names the span and drops empty attributes", async () => {
    const { span, names } = recorder();
    await withSpan(
      "uploads.classify",
      { "file.size": 10, blank: "", gone: undefined },
      async (s) => {
        s.setAttributes({ "uploads.outcome": "held", nope: undefined });
      },
    );
    expect(names).toEqual(["uploads.classify"]);
    expect(span.setAttributes).toHaveBeenNthCalledWith(1, { "file.size": 10 });
    expect(span.setAttributes).toHaveBeenNthCalledWith(2, { "uploads.outcome": "held" });
  });

  it("records a throw on the span and rethrows it", async () => {
    const { span } = recorder();
    const err = new TypeError("boom");
    await expect(
      withSpan("uploads.x", {}, async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(span.recordException).toHaveBeenCalledWith(err);
    expect(span.setStatus).toHaveBeenCalledWith({ code: "error", message: "TypeError" });
  });

  it("keeps working when setting attributes throws", async () => {
    __setEnterSpan((_name, callback) =>
      callback({
        setAttributes() {
          throw new Error("telemetry down");
        },
      }),
    );
    await expect(
      withSpan("uploads.x", { a: 1 }, async (s) => {
        s.setAttributes({ b: 2 });
        return 7;
      }),
    ).resolves.toBe(7);
  });
});

describe("annotateSpan / nameActiveSpan", () => {
  it("write to the active span", () => {
    const setAttributes = vi.fn();
    const updateName = vi.fn();
    __setIssueSpan({ setAttribute: vi.fn(), setAttributes, updateName });
    annotateSpan({ "mcp.tool.count": 3, skip: undefined });
    nameActiveSpan("GET /v1/workspaces/:workspace/files");
    expect(setAttributes).toHaveBeenCalledWith({ "mcp.tool.count": 3 });
    expect(updateName).toHaveBeenCalledWith("GET /v1/workspaces/:workspace/files");
  });

  it("do nothing when getActiveSpan throws", () => {
    __setIssueSpanExplode(true);
    expect(() => annotateSpan({ a: 1 })).not.toThrow();
    expect(() => nameActiveSpan("x")).not.toThrow();
  });
});
