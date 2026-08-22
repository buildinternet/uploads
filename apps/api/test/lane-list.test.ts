/**
 * Task C4 (two-lane storage, PR C): the composite-cursor codec, the
 * per-lane resume-state codec, and the k-way merge across lane pages. See
 * docs/superpowers/specs/2026-08-22-two-lane-storage-design.md, "Listing:
 * merged fan-out".
 */
import { describe, expect, it } from "vitest";
import {
  decodeLaneCursor,
  decodeLaneResumeState,
  encodeLaneCursor,
  encodeLaneResumeState,
  LANE_DONE,
  mergeBounded,
  type LaneCursorMap,
} from "../src/lane-list";

describe("encodeLaneCursor / decodeLaneCursor", () => {
  it("round-trips a composite cursor", () => {
    const map: LaneCursorMap = {
      v: 1,
      lanes: { active: "cursor-a", lane_fallback1: "cursor-b" },
      after: "shot.png",
    };
    const encoded = encodeLaneCursor(map);
    expect(decodeLaneCursor(encoded)).toEqual(map);
  });

  it("round-trips an empty lanes map with no `after`", () => {
    const map: LaneCursorMap = { v: 1, lanes: {} };
    expect(decodeLaneCursor(encodeLaneCursor(map))).toEqual(map);
  });

  it("returns null for undefined", () => {
    expect(decodeLaneCursor(undefined)).toBeNull();
  });

  it("returns null for garbage (not base64url JSON)", () => {
    expect(decodeLaneCursor("not-a-cursor!!!")).toBeNull();
  });

  it("returns null for a plain (non-composite) opaque provider cursor", () => {
    // A single-lane era cursor happens to not decode to `{ v: 1, lanes }`.
    expect(decodeLaneCursor("opaque-r2-cursor-token")).toBeNull();
  });

  it("returns null for well-formed JSON missing v:1", () => {
    const encoded = encodeLaneCursor({ v: 2, lanes: {} } as unknown as LaneCursorMap);
    expect(decodeLaneCursor(encoded)).toBeNull();
  });

  it("returns null when a lanes value is not a string (crafted cursor)", () => {
    const raw = JSON.stringify({ v: 1, lanes: { active: 5 } });
    const encoded = Buffer.from(raw, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(decodeLaneCursor(encoded)).toBeNull();
  });

  it("returns null when lanes is an array instead of an object", () => {
    const raw = JSON.stringify({ v: 1, lanes: ["not-an-object"] });
    const encoded = Buffer.from(raw, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(decodeLaneCursor(encoded)).toBeNull();
  });

  it("returns null when `after` is present but not a string", () => {
    const raw = JSON.stringify({ v: 1, lanes: {}, after: 5 });
    const encoded = Buffer.from(raw, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(decodeLaneCursor(encoded)).toBeNull();
  });
});

describe("encodeLaneResumeState / decodeLaneResumeState", () => {
  it("round-trips a provider cursor", () => {
    expect(decodeLaneResumeState(encodeLaneResumeState("provider-cursor-123"))).toEqual({
      cursor: "provider-cursor-123",
      done: false,
    });
  });

  it("round-trips 'start of listing' (undefined cursor)", () => {
    expect(decodeLaneResumeState(encodeLaneResumeState(undefined))).toEqual({
      cursor: undefined,
      done: false,
    });
  });

  it("decodes LANE_DONE as done, regardless of cursor", () => {
    expect(decodeLaneResumeState(LANE_DONE)).toEqual({ cursor: undefined, done: true });
  });

  it("decodes an absent (undefined) raw value as 'start of listing', not done", () => {
    // The bug this guards: an earlier version of this cursor used "absent
    // from the map" to mean exhausted, which collided with "never started"
    // and caused an exhausted lane to restart from the beginning.
    expect(decodeLaneResumeState(undefined)).toEqual({ cursor: undefined, done: false });
  });
});

describe("mergeBounded", () => {
  it("interleaves ascending keys from multiple lanes", () => {
    const merged = mergeBounded(
      [{ items: [{ key: "b" }, { key: "d" }] }, { items: [{ key: "a" }, { key: "c" }] }],
      Number.POSITIVE_INFINITY,
    );
    expect(merged.items.map((i) => i.key)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the lowest-priority (index 0) entry on a duplicate key", () => {
    const active = { key: "shot.png", from: "active" };
    const fallback = { key: "shot.png", from: "fallback" };
    const merged = mergeBounded(
      [{ items: [active] }, { items: [fallback] }],
      Number.POSITIVE_INFINITY,
    );
    expect(merged.items).toEqual([active]);
  });

  it("is stable within a page", () => {
    const merged = mergeBounded(
      [
        {
          items: [
            { key: "a", n: 1 },
            { key: "a", n: 2 },
          ],
        },
      ],
      Number.POSITIVE_INFINITY,
    );
    expect(merged.items.map((i) => (i as { n: number }).n)).toEqual([1, 2]);
  });

  it("stops at the limit and reports how far each page's pointer advanced", () => {
    const active = { items: [{ key: "a" }, { key: "c" }, { key: "e" }] };
    const fallback = { items: [{ key: "b" }, { key: "d" }, { key: "f" }] };
    const result = mergeBounded([active, fallback], 4);
    expect(result.items.map((i) => i.key)).toEqual(["a", "b", "c", "d"]);
    // 2 of active's 3 items consumed (a, c); 2 of fallback's 3 (b, d).
    expect(result.consumed).toEqual([2, 2]);
  });

  it("counts a discarded duplicate as consumed on the losing page", () => {
    const active = { items: [{ key: "a" }] };
    const fallback = { items: [{ key: "a" }, { key: "b" }] };
    const result = mergeBounded([active, fallback], 2);
    expect(result.items.map((i) => i.key)).toEqual(["a", "b"]);
    // fallback's "a" was scanned (and discarded as a dup) plus "b" emitted.
    expect(result.consumed).toEqual([1, 2]);
  });

  it("consumed is 0 for a page whose items were never reached", () => {
    const active = { items: [{ key: "a" }, { key: "b" }] };
    const fallback = { items: [{ key: "z" }] };
    const result = mergeBounded([active, fallback], 1);
    expect(result.items.map((i) => i.key)).toEqual(["a"]);
    expect(result.consumed).toEqual([1, 0]);
  });
});
