import { describe, expect, it } from "vitest";
import { cursorListReducer, initialCursorList } from "./cursor-list";

const reduce = cursorListReducer<{ id: string }>((row) => row.id);

describe("cursorListReducer", () => {
  it("starts ready from a seed and loading without one", () => {
    expect(initialCursorList({ rows: [{ id: "a" }], nextCursor: "c1" })).toMatchObject({
      gen: 0,
      status: "ready",
      rows: [{ id: "a" }],
      nextCursor: "c1",
      more: "idle",
    });
    expect(initialCursorList()).toMatchObject({ status: "loading", rows: [] });
  });

  it("applies a first page for the current generation", () => {
    const loading = reduce(initialCursorList(), { type: "reset", gen: 1 });
    const ready = reduce(loading, {
      type: "first",
      gen: 1,
      ok: true,
      rows: [{ id: "a" }],
      nextCursor: null,
    });
    expect(ready).toMatchObject({ status: "ready", rows: [{ id: "a" }], nextCursor: null });
    expect(reduce(loading, { type: "first", gen: 1, ok: false })).toMatchObject({
      status: "error",
    });
  });

  it("appends Load more pages and dedupes", () => {
    const start = initialCursorList({ rows: [{ id: "a" }], nextCursor: "c1" });
    const pending = reduce(start, { type: "more-start", gen: 0 });
    expect(pending.more).toBe("loading");
    const next = reduce(pending, {
      type: "more",
      gen: 0,
      ok: true,
      rows: [{ id: "a" }, { id: "b" }],
      nextCursor: null,
    });
    expect(next).toMatchObject({
      rows: [{ id: "a" }, { id: "b" }],
      nextCursor: null,
      more: "idle",
    });
    expect(reduce(pending, { type: "more", gen: 0, ok: false }).more).toBe("error");
  });

  it("ignores a Load more page that lands after a filter change (Review Focus 2)", () => {
    const start = initialCursorList({ rows: [{ id: "old" }], nextCursor: "c1" });
    const pending = reduce(start, { type: "more-start", gen: 0 });
    const filtered = reduce(pending, { type: "reset", gen: 1 });
    const fresh = reduce(filtered, {
      type: "first",
      gen: 1,
      ok: true,
      rows: [{ id: "new" }],
      nextCursor: null,
    });
    const stale = reduce(fresh, {
      type: "more",
      gen: 0,
      ok: true,
      rows: [{ id: "old-2" }],
      nextCursor: "c2",
    });
    expect(stale).toBe(fresh);
    expect(reduce(fresh, { type: "first", gen: 0, ok: false })).toBe(fresh);
  });

  it("drops a stale more-start and a stale more failure after a reset", () => {
    const start = initialCursorList({ rows: [{ id: "old" }], nextCursor: "c1" });
    const fresh = reduce(reduce(start, { type: "reset", gen: 1 }), {
      type: "first",
      gen: 1,
      ok: true,
      rows: [{ id: "new" }],
      nextCursor: "c9",
    });
    expect(reduce(fresh, { type: "more-start", gen: 0 })).toBe(fresh);
    expect(reduce(fresh, { type: "more", gen: 0, ok: false })).toBe(fresh);
  });
});
