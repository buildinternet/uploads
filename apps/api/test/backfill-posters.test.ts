import { describe, expect, it, vi } from "vitest";
// @ts-expect-error backfill-posters.mjs lives at the repo-root scripts/ dir,
// outside apps/api's TS project (tsconfig `include`), so there's no
// declaration file for it — the import still resolves fine at runtime.
import { classifyItem, runBackfill } from "../../../scripts/backfill-posters.mjs";

describe("classifyItem", () => {
  it("skips an item that already carries video.poster (idempotent)", () => {
    expect(
      classifyItem({
        contentType: "video/mp4",
        size: 100,
        metadata: { "video.poster": "1" },
      }),
    ).toEqual({ skip: "already-postered" });
  });

  it("skips a non-video/mp4 content type", () => {
    expect(classifyItem({ contentType: "image/png", size: 100 })).toEqual({
      skip: "not-video/mp4",
    });
  });

  it("skips an item over the max input size", () => {
    expect(classifyItem({ contentType: "video/mp4", size: 100 * 1024 * 1024 + 1 })).toEqual({
      skip: "too-large (>100MB)",
    });
  });

  it("returns a candidate otherwise", () => {
    expect(classifyItem({ contentType: "video/mp4", size: 100 })).toEqual({
      candidate: true,
    });
  });
});

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  };
}

describe("runBackfill", () => {
  const baseOpts = {
    apiUrl: "https://api.example.test",
    workspace: "default",
    token: "tok_123",
    sleepImpl: async () => {},
  };

  it("dry-run performs no PUT requests", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/files?")) {
        return jsonResponse({
          items: [
            {
              key: "a.mp4",
              contentType: "video/mp4",
              size: 100,
              url: "https://example.test/a.mp4",
            },
          ],
          cursor: null,
        });
      }
      throw new Error(`unexpected fetch in dry-run: ${url}`);
    });

    const summary = await runBackfill({ ...baseOpts, dryRun: true, fetchImpl });

    expect(summary.generated).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("forwards X-Uploads-Visibility: private on the re-PUT for a private item", async () => {
    const puts: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      if (url.includes("/files?")) {
        return jsonResponse({
          items: [
            {
              key: "private.mp4",
              contentType: "video/mp4",
              size: 100,
              url: "https://example.test/private.mp4",
              visibility: "private",
            },
          ],
          cursor: null,
        });
      }
      if (url.endsWith("/private.mp4") && !init) {
        // download of bytes (no init = plain GET of item.url)
        return jsonResponse({});
      }
      if (url.includes("/files/private.mp4")) {
        puts.push(init as Record<string, unknown>);
        return jsonResponse({});
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const summary = await runBackfill({ ...baseOpts, fetchImpl });

    expect(summary.generated).toBe(1);
    expect(puts).toHaveLength(1);
    const headers = puts[0].headers as Record<string, string>;
    expect(headers["X-Uploads-Visibility"]).toBe("private");
  });

  it("does not send X-Uploads-Visibility on the re-PUT for a public item", async () => {
    const puts: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: Record<string, unknown>) => {
      if (url.includes("/files?")) {
        return jsonResponse({
          items: [
            {
              key: "public.mp4",
              contentType: "video/mp4",
              size: 100,
              url: "https://example.test/public.mp4",
            },
          ],
          cursor: null,
        });
      }
      if (url.endsWith("/public.mp4") && !init) {
        return jsonResponse({});
      }
      if (url.includes("/files/public.mp4")) {
        puts.push(init as Record<string, unknown>);
        return jsonResponse({});
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const summary = await runBackfill({ ...baseOpts, fetchImpl });

    expect(summary.generated).toBe(1);
    expect(puts).toHaveLength(1);
    const headers = puts[0].headers as Record<string, string>;
    expect(headers["X-Uploads-Visibility"]).toBeUndefined();
  });
});
