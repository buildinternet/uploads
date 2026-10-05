/**
 * Cursor-paginated list state for the Files views, as a pure reducer so the
 * stale-response rule is testable: every first-page fetch bumps `gen`, and
 * any page tagged with an older `gen` (a Load more that lands after a filter
 * change) is dropped.
 */
import { appendPage } from "./files-scope";

export type Loaded<T> = { ok: true; value: T } | { ok: false };

export interface CursorPage<T> {
  rows: T[];
  nextCursor: string | null;
}

export interface CursorListState<T> {
  gen: number;
  status: "loading" | "error" | "ready";
  rows: T[];
  nextCursor: string | null;
  more: "idle" | "loading" | "error";
}

export type CursorListAction<T> =
  | { type: "reset"; gen: number }
  | { type: "first"; gen: number; ok: true; rows: T[]; nextCursor: string | null }
  | { type: "first"; gen: number; ok: false }
  | { type: "more-start"; gen: number }
  | { type: "more"; gen: number; ok: true; rows: T[]; nextCursor: string | null }
  | { type: "more"; gen: number; ok: false };

export function initialCursorList<T>(seed?: CursorPage<T>): CursorListState<T> {
  return seed
    ? { gen: 0, status: "ready", rows: seed.rows, nextCursor: seed.nextCursor, more: "idle" }
    : { gen: 0, status: "loading", rows: [], nextCursor: null, more: "idle" };
}

export function cursorListReducer<T>(
  keyOf: (row: T) => string,
): (state: CursorListState<T>, action: CursorListAction<T>) => CursorListState<T> {
  return (state, action) => {
    if (action.type === "reset") {
      return { gen: action.gen, status: "loading", rows: [], nextCursor: null, more: "idle" };
    }
    if (action.gen !== state.gen) return state;
    if (action.type === "first") {
      return action.ok
        ? {
            ...state,
            status: "ready",
            rows: action.rows,
            nextCursor: action.nextCursor,
            more: "idle",
          }
        : { ...state, status: "error" };
    }
    if (action.type === "more-start") return { ...state, more: "loading" };
    return action.ok
      ? {
          ...state,
          rows: appendPage(state.rows, action.rows, keyOf),
          nextCursor: action.nextCursor,
          more: "idle",
        }
      : { ...state, more: "error" };
  };
}
