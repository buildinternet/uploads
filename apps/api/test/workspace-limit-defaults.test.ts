import { describe, expect, it } from "vitest";
import template from "../scripts/workspace-limit-defaults.json";

/**
 * Source of truth for new-workspace limits (`add-workspace.mjs`).
 * Keep in sync with the shared/agent profile in docs/ops.md.
 */
describe("workspace-limit-defaults.json", () => {
  it("matches the shared/agent profile", () => {
    expect(template).toEqual({
      maxStorageBytes: 25_000_000_000,
      maxUploadsPerPeriod: 10_000,
      maxUploadBytes: 25_000_000,
      maxVideoUploadBytes: 8_000_000,
      allowedKeyPrefixes: ["f", "screenshots", "gh"],
      maxKeyDepth: 8,
    });
    // Retention is opt-in (GitHub embeds should not vanish after N days).
    expect(template).not.toHaveProperty("retentionDays");
  });
});
