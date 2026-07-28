/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { writeAdoptionPoint } from "../src/adoption";

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
});
