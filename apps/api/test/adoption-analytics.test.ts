/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { BLOB_ORDER, writeAdoptionPoint } from "../src/adoption";

interface Captured {
  blobs?: unknown[];
  doubles?: number[];
  indexes?: string[];
}

function fakeAnalytics() {
  const points: Captured[] = [];
  return {
    points,
    binding: { writeDataPoint: (point: Captured) => points.push(point) },
  };
}

describe("writeAdoptionPoint", () => {
  it("writes one point per upload with the workspace as the index", () => {
    const analytics = fakeAnalytics();
    const env = { ANALYTICS: analytics.binding } as unknown as Env;
    writeAdoptionPoint(env, {
      metric: "upload",
      workspace: "acme",
      bytes: 2048,
      dimensions: { surface: "api", contentType: "image/png", client: "uploads-cli/0.30.0" },
    });
    expect(analytics.points).toHaveLength(1);
    expect(analytics.points[0]?.indexes).toEqual(["acme"]);
    expect(analytics.points[0]?.doubles).toEqual([2048]);
    expect(analytics.points[0]?.blobs).toEqual([
      "acme",
      "api",
      "image/png",
      "uploads-cli/0.30.0",
      "",
      "",
    ]);
  });

  it("writes nothing for non-upload metrics", () => {
    const analytics = fakeAnalytics();
    const env = { ANALYTICS: analytics.binding } as unknown as Env;
    writeAdoptionPoint(env, { metric: "gallery_created", workspace: "acme" });
    expect(analytics.points).toHaveLength(0);
  });

  it("is a no-op when the binding is absent", () => {
    expect(() =>
      writeAdoptionPoint({} as unknown as Env, { metric: "upload", workspace: "acme", bytes: 1 }),
    ).not.toThrow();
  });

  it("never throws when the binding itself fails", () => {
    const env = {
      ANALYTICS: {
        writeDataPoint: () => {
          throw new Error("AE down");
        },
      },
    } as unknown as Env;
    expect(() =>
      writeAdoptionPoint(env, { metric: "upload", workspace: "acme", bytes: 1 }),
    ).not.toThrow();
  });

  it("substitutes empty strings for absent dimensions so blob positions stay stable", () => {
    const analytics = fakeAnalytics();
    const env = { ANALYTICS: analytics.binding } as unknown as Env;
    writeAdoptionPoint(env, { metric: "upload", workspace: "acme", bytes: 1 });
    expect(analytics.points[0]?.blobs).toEqual(["acme", "", "", "", "", ""]);
  });

  // Fix 1 (structural blob-ordinal contract): the blobs array is now DERIVED
  // from BLOB_ORDER rather than hand-listed, so this locks in that the
  // physical ordinals nothing has changed — workspace stays blob1 (array
  // index 0) and repo stays blob6 (array index 5), matching the historical
  // shape before the derivation existed.
  it("derives the blobs array from BLOB_ORDER without shifting any ordinal", () => {
    expect(BLOB_ORDER).toEqual(["workspace", "surface", "contentType", "client", "plan", "repo"]);

    const analytics = fakeAnalytics();
    const env = { ANALYTICS: analytics.binding } as unknown as Env;
    writeAdoptionPoint(env, {
      metric: "upload",
      workspace: "acme",
      bytes: 1,
      dimensions: {
        surface: "api",
        contentType: "image/png",
        client: "uploads-cli/0.30.0",
        repo: "acme/web",
      },
    });
    const blobs = analytics.points[0]?.blobs ?? [];
    expect(blobs).toHaveLength(BLOB_ORDER.length);
    // workspace at index 0 (blob1)
    expect(blobs[0]).toBe("acme");
    // plan's reserved slot (blob5, index 4) stays empty — no caller sets it.
    expect(blobs[4]).toBe("");
    // repo stays at index 5 (blob6), never shifted by plan's removal from
    // AdoptionDimensions.
    expect(blobs[5]).toBe("acme/web");
  });
});
