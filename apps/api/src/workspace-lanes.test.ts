/**
 * Provider fidelity for `promoteLane`/`demoteActiveLane` (issue #583 s3
 * follow-up): switching the active lane must never silently coerce an s3
 * lane's provider/endpoint/region/forcePathStyle into r2 shape, in either
 * direction. Companion to `storage-health.test.ts` (which exercises these
 * two functions for the r2-only health-flag behavior) — this file is s3-
 * focused.
 */
import { describe, expect, it } from "vitest";
import { demoteActiveLane, promoteLane, type PromotableLane } from "./workspace-lanes";
import type { StorageLane, WorkspaceRecord } from "./workspace";

/** An active-lane record on an s3-compatible bucket. */
function s3ActiveRecord(extra: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    provider: "s3",
    bucket: "acme-s3-bucket",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    forcePathStyle: true,
    accessKeyId: "enc:v1:key",
    secretAccessKey: "enc:v1:secret",
    storageLaneId: "lane_s3active",
    ...extra,
  } as WorkspaceRecord;
}

/** A saved standby `StorageLane` on an s3-compatible bucket. */
function s3StandbyLane(extra: Partial<StorageLane> = {}): StorageLane {
  return {
    id: "lane_s3standby",
    provider: "s3",
    bucket: "acme-s3-bucket-2",
    endpoint: "https://s3.eu-west-2.amazonaws.com",
    region: "eu-west-2",
    forcePathStyle: false,
    accessKeyId: "enc:v1:key2",
    secretAccessKey: "enc:v1:secret2",
    storageAccessKeyIdLast4: "1234",
    ...extra,
  };
}

/** An active-lane record on an r2 bucket (HTTP-credential mode, not binding). */
function r2ActiveRecord(extra: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    provider: "r2",
    bucket: "acme-r2-bucket",
    accountId: "a".repeat(32),
    accessKeyId: "enc:v1:key",
    secretAccessKey: "enc:v1:secret",
    jurisdiction: "eu",
    storageLaneId: "lane_r2active",
    ...extra,
  } as WorkspaceRecord;
}

describe("promoteLane", () => {
  it("promotes an s3 standby lane: active record gets provider s3 plus endpoint/region/forcePathStyle", () => {
    const next: WorkspaceRecord = { provider: "r2", bucket: "old-shared", binding: "BUCKET" };
    promoteLane(next, s3StandbyLane() as PromotableLane, "2026-08-30T00:00:00.000Z");
    expect(next.provider).toBe("s3");
    expect(next.bucket).toBe("acme-s3-bucket-2");
    expect(next.endpoint).toBe("https://s3.eu-west-2.amazonaws.com");
    expect(next.region).toBe("eu-west-2");
    expect(next.forcePathStyle).toBe(false);
    // Switching from a binding-mode lane must drop the stale binding.
    expect(next.binding).toBeUndefined();
    // No r2-only fields leak onto an s3 active lane.
    expect(next.accountId).toBeUndefined();
    expect(next.jurisdiction).toBeUndefined();
  });

  it("promoting an r2 lane onto a previously-s3 active record drops the stale s3 fields", () => {
    const next: WorkspaceRecord = s3ActiveRecord();
    const r2Lane: PromotableLane = {
      id: "lane_r2standby",
      provider: "r2",
      bucket: "acme-r2-bucket-2",
      accountId: "b".repeat(32),
      accessKeyId: "enc:v1:x",
      secretAccessKey: "enc:v1:y",
      jurisdiction: "fedramp",
    };
    promoteLane(next, r2Lane, "2026-08-30T00:00:00.000Z");
    expect(next.provider).toBe("r2");
    expect(next.accountId).toBe("b".repeat(32));
    expect(next.jurisdiction).toBe("fedramp");
    expect(next.endpoint).toBeUndefined();
    expect(next.region).toBeUndefined();
    expect(next.forcePathStyle).toBeUndefined();
  });
});

describe("demoteActiveLane", () => {
  it("demotes an s3 active record into a fallback lane that keeps its own provider/endpoint/region/forcePathStyle", () => {
    const current = s3ActiveRecord();
    const demoted = demoteActiveLane(current, "2026-08-30T00:00:00.000Z");
    expect(demoted.provider).toBe("s3");
    expect(demoted.bucket).toBe("acme-s3-bucket");
    expect(demoted.endpoint).toBe("https://s3.us-east-1.amazonaws.com");
    expect(demoted.region).toBe("us-east-1");
    expect(demoted.forcePathStyle).toBe(true);
    expect(demoted.accountId).toBeUndefined();
  });

  it("demotes an r2 active record into a fallback lane that keeps provider r2 and no s3 fields", () => {
    const current = r2ActiveRecord();
    const demoted = demoteActiveLane(current, "2026-08-30T00:00:00.000Z");
    expect(demoted.provider).toBe("r2");
    expect(demoted.accountId).toBe("a".repeat(32));
    expect(demoted.jurisdiction).toBe("eu");
    expect(demoted.endpoint).toBeUndefined();
    expect(demoted.region).toBeUndefined();
    expect(demoted.forcePathStyle).toBeUndefined();
  });
});

describe("promote/demote round trip", () => {
  it("switching r2 -> s3 -> r2 loses nothing: each demoted fallback matches its original active fields", () => {
    // Start active on r2.
    const record = r2ActiveRecord();

    // Switch to the s3 standby: demote the r2 active into a fallback lane,
    // then promote the s3 lane onto the top level — mirrors
    // `storageActivateHandler`'s swap.
    const s3Lane = s3StandbyLane();
    const demotedR2 = demoteActiveLane(record, "2026-08-30T00:00:00.000Z");
    const afterFirstSwitch: WorkspaceRecord = { ...record, storageLanes: [demotedR2] };
    promoteLane(afterFirstSwitch, s3Lane as PromotableLane, "2026-08-30T00:01:00.000Z");

    expect(afterFirstSwitch.provider).toBe("s3");
    expect(afterFirstSwitch.endpoint).toBe(s3Lane.endpoint);
    expect(afterFirstSwitch.region).toBe(s3Lane.region);
    expect(afterFirstSwitch.forcePathStyle).toBe(s3Lane.forcePathStyle);
    expect(demotedR2.provider).toBe("r2");
    expect(demotedR2.accountId).toBe(record.accountId);
    expect(demotedR2.jurisdiction).toBe(record.jurisdiction);

    // Switch back: demote the (now active) s3 lane, promote the r2 fallback
    // back onto the top level.
    const demotedS3 = demoteActiveLane(afterFirstSwitch, "2026-08-30T00:02:00.000Z");
    const afterSecondSwitch: WorkspaceRecord = {
      ...afterFirstSwitch,
      storageLanes: [demotedS3],
    };
    promoteLane(afterSecondSwitch, demotedR2 as PromotableLane, "2026-08-30T00:03:00.000Z");

    // Back on r2, with the original r2 fields intact.
    expect(afterSecondSwitch.provider).toBe("r2");
    expect(afterSecondSwitch.bucket).toBe(record.bucket);
    expect(afterSecondSwitch.accountId).toBe(record.accountId);
    expect(afterSecondSwitch.jurisdiction).toBe(record.jurisdiction);
    expect(afterSecondSwitch.endpoint).toBeUndefined();
    expect(afterSecondSwitch.region).toBeUndefined();
    expect(afterSecondSwitch.forcePathStyle).toBeUndefined();

    // The re-demoted s3 lane kept its own provider/endpoint/region/forcePathStyle.
    expect(demotedS3.provider).toBe("s3");
    expect(demotedS3.bucket).toBe(s3Lane.bucket);
    expect(demotedS3.endpoint).toBe(s3Lane.endpoint);
    expect(demotedS3.region).toBe(s3Lane.region);
    expect(demotedS3.forcePathStyle).toBe(s3Lane.forcePathStyle);
    expect(demotedS3.accountId).toBeUndefined();
  });
});
