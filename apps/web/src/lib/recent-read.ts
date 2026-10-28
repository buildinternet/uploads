/**
 * Short-lived memo for the reads the account shell repeats on every
 * ClientRouter navigation: the session check, the workspace list, the usage
 * summary, and the rail's GitHub and storage checks.
 *
 * Module state survives soft navigations, so switching tabs within
 * {@link RECENT_READ_TTL_MS} reuses the last good answer instead of firing
 * the same requests again. Concurrent callers share one in-flight promise.
 * A result `keep` rejects (an error, signed-out, unavailable) is dropped as
 * soon as it settles, so the next caller retries. A full page load starts
 * with an empty memo, and sign-out clears it.
 */
export const RECENT_READ_TTL_MS = 30_000;

type Entry = { at: number; value: Promise<unknown> };

const entries = new Map<string, Entry>();

export function recentRead<T>(
  key: string,
  load: () => Promise<T>,
  keep: (value: T) => boolean = () => true,
  now: () => number = Date.now,
): Promise<T> {
  const hit = entries.get(key);
  if (hit && now() - hit.at < RECENT_READ_TTL_MS) return hit.value as Promise<T>;

  const entry: Entry = { at: now(), value: Promise.resolve() };
  const drop = (): void => {
    if (entries.get(key) === entry) entries.delete(key);
  };
  const value = load().then(
    (result) => {
      if (!keep(result)) drop();
      return result;
    },
    (err: unknown) => {
      drop();
      throw err;
    },
  );
  entry.value = value;
  entries.set(key, entry);
  return value;
}

/** Forget every memoized read (sign-out, tests). */
export function clearRecentReads(): void {
  entries.clear();
}
