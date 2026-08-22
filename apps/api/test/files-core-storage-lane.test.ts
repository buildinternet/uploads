/**
 * Task B3 (two-lane storage primitive): new uploads stamp `ws.storageLaneId`
 * into the R2 provenance bag as a cheap forward hook for future per-file
 * routing/migration tooling. See
 * docs/superpowers/specs/2026-08-22-two-lane-storage-design.md, "Provenance
 * stamping".
 */
import { describe, expect, it } from "vitest";
import { makePosterEnv, PNG, WORKSPACE } from "./poster-fixtures";
import { putObject, STORAGE_LANE_META_KEY } from "../src/files-core";

describe("putObject storage-lane provenance stamp", () => {
  it("stamps the active lane id when the record has one", async () => {
    const { env, bucket, ws } = makePosterEnv();
    const wsWithLane = { ...ws, storageLaneId: "lane_ab12cd34" };
    const result = await putObject(env, wsWithLane, "images/pic.png", PNG, WORKSPACE);
    // makePosterEnv's ws.prefix ("default/") is applied by the storage
    // wrapper, not reflected in the returned key — see poster-upload.test.ts.
    const stored = bucket.store.get(`default/${result.key}`);
    expect(stored?.customMetadata?.[STORAGE_LANE_META_KEY]).toBe("lane_ab12cd34");
  });

  it("stamps lane_origin when the record predates lane ids", async () => {
    const { env, bucket, ws } = makePosterEnv();
    const result = await putObject(env, ws, "images/pic2.png", PNG, WORKSPACE);
    const stored = bucket.store.get(`default/${result.key}`);
    expect(stored?.customMetadata?.[STORAGE_LANE_META_KEY]).toBe("lane_origin");
  });
});
