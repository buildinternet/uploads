/**
 * Hook around cursorListReducer. The first page refetches when `queryKey`
 * changes (skipped once when SSR seeded it, like ScreenshotsByPath's
 * overview); Load more appends with the same generation guard.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { onSession } from "../../lib/account-shell";
import {
  cursorListReducer,
  initialCursorList,
  type CursorListState,
  type CursorPage,
  type Loaded,
} from "../../lib/cursor-list";

export function useCursorList<T>(opts: {
  queryKey: string;
  seed?: CursorPage<T>;
  keyOf: (row: T) => string;
  load: (cursor: string | undefined) => Promise<Loaded<CursorPage<T>>>;
}): { state: CursorListState<T>; loadMore: () => void; retry: () => void } {
  const keyOfRef = useRef(opts.keyOf);
  const reducer = useMemo(() => cursorListReducer<T>((row) => keyOfRef.current(row)), []);
  const [state, dispatch] = useReducer(reducer, opts.seed, initialCursorList<T>);
  const loadRef = useRef(opts.load);
  const genRef = useRef(state.gen);
  const moreInFlight = useRef(false);
  const skipSeeded = useRef(opts.seed !== undefined);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    loadRef.current = opts.load;
    keyOfRef.current = opts.keyOf;
  });

  useEffect(() => {
    if (skipSeeded.current) {
      skipSeeded.current = false;
      return;
    }
    const gen = genRef.current + 1;
    genRef.current = gen;
    moreInFlight.current = false;
    dispatch({ type: "reset", gen });
    onSession(() => {
      void loadRef.current(undefined).then((result) => {
        dispatch(
          result.ok
            ? {
                type: "first",
                gen,
                ok: true,
                rows: result.value.rows,
                nextCursor: result.value.nextCursor,
              }
            : { type: "first", gen, ok: false },
        );
      });
    });
  }, [opts.queryKey, nonce]);

  const loadMore = () => {
    if (state.status !== "ready" || !state.nextCursor || state.more === "loading") return;
    if (moreInFlight.current) return;
    moreInFlight.current = true;
    const gen = genRef.current;
    const cursor = state.nextCursor;
    dispatch({ type: "more-start", gen });
    void loadRef.current(cursor).then((result) => {
      // A reset since this request started owns the flag now; leave it alone.
      if (genRef.current === gen) moreInFlight.current = false;
      dispatch(
        result.ok
          ? {
              type: "more",
              gen,
              ok: true,
              rows: result.value.rows,
              nextCursor: result.value.nextCursor,
            }
          : { type: "more", gen, ok: false },
      );
    });
  };

  return { state, loadMore, retry: () => setNonce((n) => n + 1) };
}
