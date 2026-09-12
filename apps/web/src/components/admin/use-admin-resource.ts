/**
 * Fetch-on-mount for the workspace drawer's read-only-until-edited sections.
 * Every editor loaded its data with the same `let alive = true` effect + catch;
 * this centralizes that load/cancel/error scaffolding so each section keeps only
 * its own editable buffer. `reload()` refetches (after a mutation), and `deps`
 * refires the load when they change (e.g. a parent-owned reload nonce).
 *
 * `load` is intentionally NOT a dependency — it's a fresh closure each render;
 * the load reruns on `deps`/`reload` only, matching the hand-written effects
 * this replaces.
 */
import { useCallback, useEffect, useState } from "react";

export interface AdminResource<T> {
  data: T | null;
  error: boolean;
  setData: (data: T) => void;
  reload: () => void;
}

export function useAdminResource<T>(load: () => Promise<T>, deps: unknown[]): AdminResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    load()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(false);
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, setData, reload };
}
