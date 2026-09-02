/**
 * Unit tests for `workspace-storage.ts` pieces too low-level for the route
 * suite (`apps/api/test/routes-workspace-settings.test.ts`), which drives
 * `laneActiveContentCheck` entirely through `setLaneActiveContentCheckForTests`
 * and so never exercises the real implementation's own error handling.
 */
import { describe, expect, it } from "vitest";
import { laneActiveContentCheck } from "./workspace-storage";
import type { StorageLane } from "../workspace";

function makeEnv(): Env {
  return { WORKSPACE_SECRETS_KEY: "test-workspace-secrets-key-0000" } as unknown as Env;
}

describe("laneActiveContentCheck — fails soft on a storage-client error (issue #929 review)", () => {
  it("returns an inconclusive check instead of throwing when the storage client can't even be built", async () => {
    // A syntactically-present but shape-invalid s3 endpoint (a path
    // segment) passes `storageConfig`'s bare presence check but fails
    // `defaultStorageClientFactory`'s own stricter re-guard — a real,
    // deterministic way to exercise "the client build/upload step throws"
    // without mocking the network or crypto.
    const lane: StorageLane = {
      id: "lane_bad_s3",
      provider: "s3",
      bucket: "customer-bucket",
      endpoint: "https://s3.example.com/not-a-bare-origin",
      region: "us-east-1",
      accessKeyId: "AKIDEXAMPLE1234",
      secretAccessKey: "super-secret-value",
      publicBaseUrl: "https://media.example.com",
    };

    const check = await laneActiveContentCheck(makeEnv(), lane);

    expect(check).toEqual({
      id: "active-content-headers",
      ok: false,
      required: false,
      inconclusive: true,
      hint: "could not write the SVG probe to this bucket — check the lane's credentials, then check again",
    });
  });
});
