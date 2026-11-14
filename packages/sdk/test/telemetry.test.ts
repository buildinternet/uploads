import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUploadsClient, UploadsError } from "../src/index.js";

// A real OpenTelemetry SDK, registered the way an app would. The SDK under
// test never imports @opentelemetry/api; it finds this provider on its own.
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
trace.setGlobalTracerProvider(provider);

afterAll(() => trace.disable());
beforeEach(() => exporter.reset());

const config = { token: "up_ws_secret", workspace: "ws", apiUrl: "https://api.test" };

function respond(body: unknown, status = 200) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch;
}

describe("OpenTelemetry spans", () => {
  it("records a client span per call on the app's registered tracer", async () => {
    const fetch = respond(
      { workspace: "ws", key: "a.png", url: "https://cdn.test/a.png", holdCheck: "pending" },
      201,
    );
    const client = createUploadsClient(config, { fetch });
    await client.put("secret-name.png", new Uint8Array([1, 2, 3]), {
      contentType: "image/png",
      metadata: { caption: "private words" },
    });

    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("uploads.put");
    expect(span?.kind).toBe(2);
    expect(span?.instrumentationScope.name).toBe("@buildinternet/uploads-sdk");
    expect(span?.attributes).toEqual({
      "uploads.workspace": "ws",
      "server.address": "api.test",
      "file.size": 3,
      "file.content_type": "image/png",
      "uploads.replaced": false,
      "uploads.hold_check": "pending",
    });
    const serialized = JSON.stringify(span?.attributes);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("private words");
  });

  it("marks a failed call with the error code", async () => {
    const client = createUploadsClient(config, {
      fetch: respond({ error: "not found", code: "not_found" }, 404),
    });
    await expect(client.head("missing.png")).rejects.toBeInstanceOf(UploadsError);
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe("uploads.head");
    expect(span?.status.code).toBe(2);
    expect(span?.attributes["error.type"]).toBe("NOT_FOUND");
    expect(span?.events.map((e) => e.name)).toContain("exception");
  });

  it("records nothing with tracer: false", async () => {
    const client = createUploadsClient(config, {
      fetch: respond({ ok: true }),
      tracer: false,
    });
    await client.health();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("uses an explicit tracer over the global one", async () => {
    const other = new InMemorySpanExporter();
    const explicit = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(other)],
    }).getTracer("app");
    const client = createUploadsClient(config, { fetch: respond({ ok: true }), tracer: explicit });
    await client.health();
    expect(other.getFinishedSpans().map((s) => s.name)).toEqual(["uploads.health"]);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
