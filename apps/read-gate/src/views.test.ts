import { describe, expect, it, vi } from "vitest";
import { handleReadGate, type ReadGateEnv } from "./index";
import { referrerClass, VIEW_BLOB_ORDER, writeViewPoint } from "./views";

function gateEnv(first: () => Promise<unknown>) {
  const points: AnalyticsEngineDataPoint[] = [];
  const env = {
    DB: { prepare: () => ({ bind: () => ({ first }) }) },
    VIEWS: { writeDataPoint: (point: AnalyticsEngineDataPoint) => points.push(point) },
  } as unknown as ReadGateEnv;
  return { env, points };
}

const ctx = { waitUntil() {} };

function req(headers: Record<string, string>): Request {
  return new Request("https://storage.uploads.sh/acme/a.png", { headers });
}

describe("referrerClass", () => {
  it("classifies camo, Slack, transforms, direct, and other", () => {
    expect(referrerClass(req({ "user-agent": "github-camo (4b2a3e9)" }), false)).toBe(
      "github_camo",
    );
    expect(referrerClass(req({ "user-agent": "Slackbot-LinkExpanding 1.0" }), false)).toBe("slack");
    expect(referrerClass(req({ referer: "https://app.slack.com/client/T1" }), false)).toBe("slack");
    expect(referrerClass(req({ "user-agent": "github-camo" }), true)).toBe("cdn_cgi_image");
    expect(referrerClass(req({}), false)).toBe("direct");
    expect(referrerClass(req({ referer: "https://example.com/post" }), false)).toBe("other");
  });
});

describe("view points", () => {
  it("writes one point per hosted GET in blob order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bytes", { headers: { "content-length": "5" } })),
    );
    const { env, points } = gateEnv(async () => null);
    await handleReadGate(
      new Request("https://embed.uploads.sh/acme/f/x/shot.png", {
        headers: { "user-agent": "github-camo (abc)" },
      }),
      env,
      ctx,
    );
    expect(VIEW_BLOB_ORDER).toEqual(["workspace", "objectKey", "referrer", "gate"]);
    expect(points).toEqual([
      {
        indexes: ["acme"],
        blobs: ["acme", "acme/f/x/shot.png", "github_camo", "allow"],
        doubles: [200, 5],
      },
    ]);
    vi.unstubAllGlobals();
  });

  it("records held and fail-open reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bytes")),
    );
    const held = gateEnv(async () => ({ hit: 1 }));
    await handleReadGate(new Request("https://store.uploads.sh/acme/notes.pdf"), held.env, ctx);
    expect(held.points[0]?.blobs?.[3]).toBe("block");
    expect(held.points[0]?.doubles?.[0]).toBe(404);

    const down = gateEnv(async () => {
      throw new Error("d1");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await handleReadGate(new Request("https://store.uploads.sh/acme/a.png"), down.env, ctx);
    expect(down.points[0]?.blobs?.[3]).toBe("fail_open");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("counts a transform once and skips HEAD, OPTIONS, and other hosts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bytes")),
    );
    const { env, points } = gateEnv(async () => null);
    await handleReadGate(
      new Request("https://storage.uploads.sh/cdn-cgi/image/format=png/acme/shot.avif"),
      env,
      ctx,
    );
    await handleReadGate(
      new Request("https://storage.uploads.sh/acme/shot.avif", {
        headers: { via: "image-resizing" },
      }),
      env,
      ctx,
    );
    await handleReadGate(
      new Request("https://storage.uploads.sh/acme/a.png", { method: "HEAD" }),
      env,
      ctx,
    );
    await handleReadGate(
      new Request("https://storage.uploads.sh/acme/a.png", { method: "OPTIONS" }),
      env,
      ctx,
    );
    await handleReadGate(new Request("https://example.com/acme/a.png"), env, ctx);
    expect(points).toHaveLength(1);
    expect(points[0]?.blobs?.slice(1, 3)).toEqual(["acme/shot.avif", "cdn_cgi_image"]);
    vi.unstubAllGlobals();
  });

  it("never throws when the binding is missing or fails", () => {
    const view = {
      objectKey: "acme/a.png",
      referrer: "direct" as const,
      gate: "allow" as const,
      status: 200,
      contentLength: -1,
    };
    expect(() => writeViewPoint(undefined, view)).not.toThrow();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      writeDataPoint() {
        throw new Error("ae");
      },
    } as AnalyticsEngineDataset;
    expect(() => writeViewPoint(broken, view)).not.toThrow();
    vi.restoreAllMocks();
  });
});
