import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isNewerVersion,
  maybeHintUpdate,
  parseSemver,
  readUpdateCache,
  writeUpdateCache,
  type UpdateCache,
} from "../src/update-check.js";

describe("parseSemver / isNewerVersion", () => {
  it("parses major.minor.patch and ignores pre-release", () => {
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(parseSemver("not-a-version")).toBeNull();
  });

  it("compares versions", () => {
    expect(isNewerVersion("0.6.0", "0.5.0")).toBe(true);
    expect(isNewerVersion("0.5.1", "0.5.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.5.0", "0.5.0")).toBe(false);
    expect(isNewerVersion("0.4.9", "0.5.0")).toBe(false);
  });
});

describe("update cache", () => {
  it("round-trips", () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-update-")), "version-check.json");
    const cache: UpdateCache = { checkedAt: 1000, latest: "0.6.0", current: "0.5.0" };
    writeUpdateCache(path, cache);
    expect(readUpdateCache(path)).toEqual(cache);
  });
});

describe("maybeHintUpdate", () => {
  function cachePath(): string {
    return join(mkdtempSync(join(tmpdir(), "uploads-update-")), "version-check.json");
  }

  function jsonResponse(version: string): Response {
    return new Response(JSON.stringify({ version }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("prints a hint when the registry reports a newer version", async () => {
    const lines: string[] = [];
    const path = cachePath();
    await maybeHintUpdate({
      currentVersion: "0.5.0",
      cachePath: path,
      now: 10_000,
      ttlMs: 0,
      fetchImpl: async () => jsonResponse("0.6.0"),
      write: (t) => lines.push(t),
    });
    expect(lines.join("")).toMatch(
      /@buildinternet\/uploads@0\.6\.0 is available \(you have 0\.5\.0\)/,
    );
    expect(lines.join("")).toMatch(/Update: uploads update/);
    expect(readUpdateCache(path)?.latest).toBe("0.6.0");
  });

  it("stays silent when already up to date", async () => {
    const lines: string[] = [];
    await maybeHintUpdate({
      currentVersion: "0.6.0",
      cachePath: cachePath(),
      ttlMs: 0,
      fetchImpl: async () => jsonResponse("0.6.0"),
      write: (t) => lines.push(t),
    });
    expect(lines).toEqual([]);
  });

  it("uses a fresh cache without fetching", async () => {
    const path = cachePath();
    writeUpdateCache(path, { checkedAt: 1_000, latest: "0.7.0", current: "0.5.0" });
    const lines: string[] = [];
    let fetches = 0;
    await maybeHintUpdate({
      currentVersion: "0.5.0",
      cachePath: path,
      now: 1_000 + 60_000,
      fetchImpl: async () => {
        fetches++;
        throw new Error("should not fetch");
      },
      write: (t) => lines.push(t),
    });
    expect(fetches).toBe(0);
    expect(lines.join("")).toMatch(/0\.7\.0/);
  });

  it("skips when quiet, mcp, or NO_UPDATE_NOTIFIER is set", async () => {
    const lines: string[] = [];
    const fetchImpl = async () => {
      throw new Error("should not fetch");
    };
    await maybeHintUpdate({
      quiet: true,
      currentVersion: "0.1.0",
      ttlMs: 0,
      fetchImpl,
      write: (t) => lines.push(t),
    });
    await maybeHintUpdate({
      command: "mcp",
      currentVersion: "0.1.0",
      ttlMs: 0,
      fetchImpl,
      write: (t) => lines.push(t),
    });
    const prev = process.env.NO_UPDATE_NOTIFIER;
    process.env.NO_UPDATE_NOTIFIER = "1";
    try {
      await maybeHintUpdate({
        currentVersion: "0.1.0",
        ttlMs: 0,
        fetchImpl,
        write: (t) => lines.push(t),
      });
    } finally {
      if (prev === undefined) delete process.env.NO_UPDATE_NOTIFIER;
      else process.env.NO_UPDATE_NOTIFIER = prev;
    }
    expect(lines).toEqual([]);
  });

  it("never throws on network failure", async () => {
    const lines: string[] = [];
    await expect(
      maybeHintUpdate({
        currentVersion: "0.5.0",
        cachePath: cachePath(),
        ttlMs: 0,
        fetchImpl: async () => {
          throw new Error("offline");
        },
        write: (t) => lines.push(t),
      }),
    ).resolves.toBeUndefined();
    expect(lines).toEqual([]);
  });

  it("falls back to a stale cache when fetch fails", async () => {
    const path = cachePath();
    writeFileSync(path, JSON.stringify({ checkedAt: 1, latest: "0.9.0", current: "0.5.0" }) + "\n");
    const lines: string[] = [];
    await maybeHintUpdate({
      currentVersion: "0.5.0",
      cachePath: path,
      now: 99_999_999,
      ttlMs: 0,
      fetchImpl: async () => {
        throw new Error("offline");
      },
      write: (t) => lines.push(t),
    });
    expect(lines.join("")).toMatch(/0\.9\.0/);
  });
});
