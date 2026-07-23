import { describe, expect, it, vi } from "vitest";
import {
  bestCliVersion,
  dismissStorageKey,
  dismissUpgrade,
  isNewerVersion,
  isUpgradeDismissed,
  parseSemver,
  resolveUpgradePrompt,
} from "./cli-upgrade";

describe("parseSemver / isNewerVersion", () => {
  it("parses and compares", () => {
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(isNewerVersion("0.27.0", "0.26.0")).toBe(true);
    expect(isNewerVersion("0.26.0", "0.26.0")).toBe(false);
    expect(isNewerVersion("0.25.0", "0.26.0")).toBe(false);
  });
});

describe("bestCliVersion", () => {
  it("prefers cliVersion over UA and the freshest session", () => {
    expect(
      bestCliVersion([
        {
          userAgent: "@buildinternet/uploads/1.0.0 (device-token)",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          cliVersion: "1.2.0",
          userAgent: "@buildinternet/uploads/1.1.0 (device-token)",
          updatedAt: "2026-07-01T00:00:00.000Z",
        },
      ]),
    ).toBe("1.2.0");
  });

  it("returns null without CLI sessions", () => {
    expect(bestCliVersion([{ userAgent: "Mozilla/5.0 Chrome/120" }])).toBeNull();
    expect(bestCliVersion([])).toBeNull();
    expect(bestCliVersion(null)).toBeNull();
  });
});

describe("resolveUpgradePrompt", () => {
  it("builds a prompt only when latest is newer", () => {
    expect(resolveUpgradePrompt("0.26.0", "0.27.0")).toMatchObject({
      current: "0.26.0",
      latest: "0.27.0",
      installCmd: "npm i -g @buildinternet/uploads",
    });
    expect(resolveUpgradePrompt("0.27.0", "0.27.0")).toBeNull();
    expect(resolveUpgradePrompt(null, "0.27.0")).toBeNull();
    expect(resolveUpgradePrompt("0.26.0", null)).toBeNull();
  });
});

describe("dismiss helpers", () => {
  it("reads and writes sessionStorage-style storage", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    };
    expect(isUpgradeDismissed("1.0.0", storage)).toBe(false);
    dismissUpgrade("1.0.0", storage);
    expect(map.get(dismissStorageKey("1.0.0"))).toBe("1");
    expect(isUpgradeDismissed("1.0.0", storage)).toBe(true);
    expect(isUpgradeDismissed("1.0.1", storage)).toBe(false);
  });

  it("tolerates storage throwing", () => {
    const boom = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(isUpgradeDismissed("1.0.0", boom)).toBe(false);
    expect(() => dismissUpgrade("1.0.0", boom)).not.toThrow();
  });
});
