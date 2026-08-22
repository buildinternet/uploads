/**
 * Task C4 (two-lane storage, PR C): the composite-cursor codec and the
 * k-way merge across lane pages. See
 * docs/superpowers/specs/2026-08-22-two-lane-storage-design.md, "Listing:
 * merged fan-out".
 */
import { describe, expect, it } from "vitest";
import {
  decodeLaneCursor,
  encodeLaneCursor,
  mergeBounded,
  mergeLaneListings,
  type LaneCursorMap,
} from "../src/lane-list";

describe("encodeLaneCursor / decodeLaneCursor", () => {
  it("round-trips a composite cursor", () => {
    const map: LaneCursorMap = { v: 1, lanes: { active: "cursor-a", lane_fallback1: "cursor-b" } };
    const encoded = encodeLaneCursor(map);
    expect(decodeLaneCursor(encoded)).toEqual(map);
  });

  it("round-trips an empty lanes map", () => {
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
});

describe("mergeLaneListings", () => {
  it("interleaves ascending keys from multiple lanes", () => {
    const merged = mergeLaneListings([
      { laneOrder: 0, items: [{ key: "b" }, { key: "d" }] },
      { laneOrder: 1, items: [{ key: "a" }, { key: "c" }] },
    ]);
    expect(merged.map((i) => i.key)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the lower-laneOrder entry on a duplicate key", () => {
    const active = { key: "shot.png", from: "active" };
    const fallback = { key: "shot.png", from: "fallback" };
    const merged = mergeLaneListings([
      { laneOrder: 0, items: [active] },
      { laneOrder: 1, items: [fallback] },
    ]);
    expect(merged).toEqual([active]);
  });

  it("is stable within a lane", () => {
    const merged = mergeLaneListings([
      {
        laneOrder: 0,
        items: [
          { key: "a", n: 1 },
          { key: "a", n: 2 },
        ],
      },
    ]);
    expect(merged.map((i) => (i as { n: number }).n)).toEqual([1, 2]);
  });
});

describe("mergeBounded", () => {
  it("stops at the limit and reports how far each lane's pointer advanced", () => {
    const active = { laneOrder: 0, items: [{ key: "a" }, { key: "c" }, { key: "e" }] };
    const fallback = { laneOrder: 1, items: [{ key: "b" }, { key: "d" }, { key: "f" }] };
    const result = mergeBounded([active, fallback], 4);
    expect(result.items.map((i) => i.key)).toEqual(["a", "b", "c", "d"]);
    // 2 of active's 3 items consumed (a, c); 2 of fallback's 3 (b, d).
    expect(result.consumed).toEqual([2, 2]);
  });

  it("counts a discarded duplicate as consumed on the losing lane", () => {
    const active = { laneOrder: 0, items: [{ key: "a" }] };
    const fallback = { laneOrder: 1, items: [{ key: "a" }, { key: "b" }] };
    const result = mergeBounded([active, fallback], 2);
    expect(result.items.map((i) => i.key)).toEqual(["a", "b"]);
    // fallback's "a" was scanned (and discarded as a dup) plus "b" emitted.
    expect(result.consumed).toEqual([1, 2]);
  });

  it("consumed is 0 for a lane whose page was never reached", () => {
    const active = { laneOrder: 0, items: [{ key: "a" }, { key: "b" }] };
    const fallback = { laneOrder: 1, items: [{ key: "z" }] };
    const result = mergeBounded([active, fallback], 1);
    expect(result.items.map((i) => i.key)).toEqual(["a"]);
    expect(result.consumed).toEqual([1, 0]);
  });
});
