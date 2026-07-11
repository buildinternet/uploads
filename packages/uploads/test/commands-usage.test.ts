import { describe, expect, it } from "vitest";
import type { UploadsClient } from "../src/client.js";
import { runUsage, runReconcile, runPurgeExpired, type CliContext } from "../src/commands.js";

function ctxWith(client: Partial<UploadsClient>, json = false): CliContext {
  return {
    config: {
      apiUrl: "https://x.test",
      workspace: "test",
      token: "up_test_x",
      workspaceSource: "override",
      configPath: "/tmp/uploads-test-config",
      configExists: false,
    },
    client: client as UploadsClient,
    json,
    quiet: true,
  };
}

describe("runUsage / runReconcile / runPurgeExpired", () => {
  it("usage returns the snapshot", async () => {
    const snap = {
      workspace: "test",
      bytes: 10,
      objects: 1,
      uploadsInPeriod: 2,
      periodStart: "2026-07",
      updatedAt: "2026-07-11T00:00:00.000Z",
    };
    const code = await runUsage(
      ctxWith({
        usage: async () => snap,
      }),
      [],
    );
    expect(code).toBe(0);
  });

  it("reconcile reports change", async () => {
    const code = await runReconcile(
      ctxWith({
        reconcile: async () => ({
          workspace: "test",
          bytes: 10,
          objects: 1,
          previous: { bytes: 0, objects: 0 },
          changed: true,
          usage: {
            workspace: "test",
            bytes: 10,
            objects: 1,
            uploadsInPeriod: 0,
            periodStart: "2026-07",
            updatedAt: "2026-07-11T00:00:00.000Z",
          },
        }),
      }),
      [],
    );
    expect(code).toBe(0);
  });

  it("purge-expired handles skip", async () => {
    const code = await runPurgeExpired(
      ctxWith({
        purgeExpired: async () => ({
          skipped: true as const,
          reason: "retentionDays not set on workspace",
        }),
      }),
      [],
    );
    expect(code).toBe(0);
  });
});
