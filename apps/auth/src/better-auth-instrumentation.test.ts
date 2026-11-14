import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as shim from "./better-auth-instrumentation";

// The real module, resolved from better-auth's own dependencies (Node picks
// its full build, not the workerd no-op). Not a direct dependency here.
const fromBetterAuth = createRequire(createRequire(import.meta.url).resolve("better-auth"));
const upstream = (await import(
  pathToFileURL(fromBetterAuth.resolve("@better-auth/core/instrumentation")).href
)) as Record<string, unknown>;

describe("Workers build of @better-auth/core/instrumentation", () => {
  it("exports what Better Auth's own module exports", () => {
    const testOnly = new Set(["spanRunner"]);
    const ours = Object.keys(shim).filter((k) => !testOnly.has(k));
    expect(ours.sort()).toEqual(Object.keys(upstream).sort());
    for (const key of Object.keys(upstream).filter((k) => k.startsWith("ATTR_"))) {
      expect(shim[key as keyof typeof shim]).toBe(upstream[key]);
    }
  });

  it("runs the work directly without a tracing API", () => {
    expect(shim.withSpan("GET /get-session", {}, () => 1)).toBe(1);
  });

  it("opens a span with Better Auth's name and attributes", async () => {
    const span = { setAttributes: vi.fn(), recordException: vi.fn(), setStatus: vi.fn() };
    const names: string[] = [];
    const withSpan = shim.spanRunner(() => ({
      enterSpan: (name, cb) => {
        names.push(name);
        return cb(span);
      },
    }));
    await expect(
      withSpan("db findOne session", { "db.operation.name": "findOne" }, async () => "row"),
    ).resolves.toBe("row");
    expect(names).toEqual(["db findOne session"]);
    expect(span.setAttributes).toHaveBeenCalledWith({ "db.operation.name": "findOne" });
  });

  it("records failures but not redirects", async () => {
    const span = { setAttributes: vi.fn(), recordException: vi.fn(), setStatus: vi.fn() };
    const withSpan = shim.spanRunner(() => ({ enterSpan: (_n, cb) => cb(span) }));
    const redirect = Object.assign(new Error("redirect"), { name: "APIError", statusCode: 302 });
    await expect(
      withSpan("GET /callback/:id", {}, async () => {
        throw redirect;
      }),
    ).rejects.toBe(redirect);
    expect(span.recordException).not.toHaveBeenCalled();
    expect(span.setAttributes).toHaveBeenLastCalledWith({ "http.response.status_code": 302 });

    const boom = new TypeError("boom");
    expect(() =>
      withSpan("POST /sign-in/email", {}, () => {
        throw boom;
      }),
    ).toThrow(boom);
    expect(span.recordException).toHaveBeenCalledWith(boom);
    expect(span.setStatus).toHaveBeenCalledWith({ code: "error", message: "TypeError" });
  });

  it("honors experimental.instrumentation.enabled: false", () => {
    expect(shim.createWithSpan({ experimental: { instrumentation: { enabled: false } } })).not.toBe(
      shim.withSpan,
    );
    expect(shim.createWithSpan({})).toBe(shim.withSpan);
  });
});
