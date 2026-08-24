import { describe, expect, it } from "vitest";
import { SLOW_OP_BLOB_ORDER, writeSlowOpPoint } from "./slow-op-analytics";

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

describe("writeSlowOpPoint", () => {
  it("writes one point with op/route/outcome blobs and wall/exec doubles", () => {
    const analytics = fakeAnalytics();
    const env = { SLOW_OPS: analytics.binding } as unknown as Env;
    writeSlowOpPoint(env, {
      op: "d1",
      route: "/v1/acme/files",
      wallMs: 1234,
      execMs: 0.4,
      outcome: "ok",
    });
    expect(analytics.points).toHaveLength(1);
    expect(analytics.points[0]?.indexes).toEqual(["d1"]);
    expect(analytics.points[0]?.blobs).toEqual(["d1", "/v1/acme/files", "ok"]);
    expect(analytics.points[0]?.doubles).toEqual([1234, 0.4]);
  });

  it("writes -1 for execMs when the event carries none (e.g. a .first() read or an error outcome)", () => {
    const analytics = fakeAnalytics();
    const env = { SLOW_OPS: analytics.binding } as unknown as Env;
    writeSlowOpPoint(env, { op: "auth", wallMs: 4001, outcome: "error" });
    expect(analytics.points[0]?.doubles).toEqual([4001, -1]);
    // route is optional on SlowOpEvent — substitutes "" to keep blob
    // positions stable, same convention as adoption.ts's writeAdoptionPoint.
    expect(analytics.points[0]?.blobs).toEqual(["auth", "", "error"]);
  });

  it("is a no-op when the SLOW_OPS binding is absent", () => {
    expect(() =>
      writeSlowOpPoint({} as unknown as Env, { op: "d1", wallMs: 1, outcome: "ok" }),
    ).not.toThrow();
  });

  it("never throws when the binding itself fails", () => {
    const env = {
      SLOW_OPS: {
        writeDataPoint: () => {
          throw new Error("AE down");
        },
      },
    } as unknown as Env;
    expect(() => writeSlowOpPoint(env, { op: "d1", wallMs: 1, outcome: "ok" })).not.toThrow();
  });

  it("derives the blob layout from SLOW_OP_BLOB_ORDER without shifting an ordinal", () => {
    expect(SLOW_OP_BLOB_ORDER).toEqual(["op", "route", "outcome"]);
  });
});
