import { describe, expect, it } from "vitest";
import type { UploadsClient } from "../src/client.js";
import { buildDoctorReport } from "../src/commands.js";
import type { ResolvedConfig } from "../src/config.js";

function fakeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    apiUrl: "https://x.test",
    workspace: "test",
    token: "up_test_x",
    workspaceSource: "override",
    configPath: "/tmp/uploads-test-config",
    configExists: false,
    ...overrides,
  };
}

function fakeClient(): UploadsClient {
  return {
    list: async () => ({ items: [], cursor: null }),
    health: async () => ({ ok: true }),
    usage: async () => ({ bytes: 0, objects: 0, uploadsInPeriod: 0 }),
  } as unknown as UploadsClient;
}

describe("buildDoctorReport browser section", () => {
  it("reports a browser section (fs scans only — never launches a browser)", async () => {
    const report = await buildDoctorReport(fakeConfig(), fakeClient());
    expect(report.browser).toBeDefined();
    // On Node (which is what runs vitest), detection is supported even if no
    // browser happens to be installed on the CI/dev machine.
    expect(report.browser.supported).toBe(true);
    expect(report.browser.autoBackend === "local" || report.browser.autoBackend === "remote").toBe(
      true,
    );
    expect(Array.isArray(report.browser.candidates)).toBe(true);
  });

  it("prints the ranked winner, not the first candidate found in scan order", async () => {
    // System browsers are scanned before the playwright cache, so a system
    // Edge install would be candidates[0] — but a playwright-cache chromium
    // outranks any non-Chrome system browser. Doctor must report the winner
    // by rank, not by scan order.
    const cacheDir = "/home/.cache/ms-playwright";
    const edgePath = "/usr/bin/microsoft-edge";
    const chromium = `${cacheDir}/chromium-1200/chrome-linux/chrome`;
    const paths = new Set([edgePath, chromium]);
    const exists = (p: string) => paths.has(p) || [...paths].some((f) => f.startsWith(`${p}/`));
    const readdir = (dir: string): string[] => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const p of paths) {
        if (!p.startsWith(prefix)) continue;
        const first = p.slice(prefix.length).split("/")[0];
        if (first) names.add(first);
      }
      return [...names];
    };

    const report = await buildDoctorReport(fakeConfig(), fakeClient(), {
      platform: "linux",
      env: {},
      systemCandidates: [{ kind: "edge", path: edgePath }],
      playwrightCacheDir: cacheDir,
      puppeteerCacheDir: "/home/.cache/puppeteer",
      exists,
      readdir,
    });

    // Scan order puts the system Edge candidate first...
    expect(report.browser.candidates[0]?.kind).toBe("edge");
    // ...but the playwright-cache chromium outranks it and must win.
    expect(report.browser.winner?.source).toBe("playwright-cache");
    expect(report.browser.winner?.kind).toBe("chromium");
    expect(report.browser.autoBackend).toBe("local");
  });
});
