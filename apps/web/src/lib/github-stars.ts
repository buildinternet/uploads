/**
 * Server-side GitHub star count for SiteHeader.
 *
 * This used to be a client fetch (`components/site-header-stars.ts`), but no
 * page CSP allows `api.github.com` in `connect-src`, so the browser blocked it
 * everywhere and a `catch` swallowed the failure — the count silently stayed
 * empty once each visitor's 1h localStorage entry expired. Fetching here keeps
 * a third-party origin out of every page's `connect-src`, spends no visitor's
 * unauthenticated GitHub rate limit (60/hr per IP), and paints the number with
 * the rest of the header instead of popping it in.
 *
 * Prerendered pages (landing, docs, legal, changelog) bake the count at build
 * time. SSR pages (account, admin) resolve it per request, so the result is
 * memoized per isolate and the request itself rides the Cloudflare edge cache.
 * Never throws and never blocks a render for long: on timeout or error the
 * count is simply absent, exactly as the old failure mode rendered.
 */

const REPO_API = "https://api.github.com/repos/buildinternet/uploads";
const OK_TTL_MS = 3_600_000;
/** Short, so a GitHub blip doesn't hide the count for a full hour... */
const FAIL_TTL_MS = 60_000;
/** ...and equally so a blip can't have us retrying on every single render. */
const TIMEOUT_MS = 1500;

/** When the last attempt ran, and whether it succeeded — drives the retry clock. */
let memo: { at: number; count: number | null } | null = null;
/** Last count actually seen. Survives later failures so the header never blanks. */
let lastGood: number | null = null;

/** Reset the per-isolate memo. Tests only. */
export function resetStarCountMemo(): void {
  memo = null;
  lastGood = null;
}

/** `1234` → `1.2k`. Kept next to the fetch so both sides format identically. */
export function formatStars(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

export async function githubStarCount(now = Date.now()): Promise<number | null> {
  const ttl = memo?.count === null ? FAIL_TTL_MS : OK_TTL_MS;
  if (memo && now - memo.at < ttl) return memo.count ?? lastGood;

  let count: number | null = null;
  try {
    const res = await fetch(REPO_API, {
      headers: {
        accept: "application/vnd.github+json",
        // GitHub rejects unauthenticated API requests that send no User-Agent.
        "user-agent": "uploads.sh",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Honored on Workers, ignored by the Node dev server.
      cf: { cacheTtl: 3600, cacheEverything: true },
    } as RequestInit);
    if (res.ok) {
      const stars = ((await res.json()) as { stargazers_count?: unknown }).stargazers_count;
      if (typeof stars === "number" && Number.isFinite(stars)) count = stars;
    }
  } catch {
    // Offline build, rate limit, timeout — the header just omits the count.
  }

  memo = { at: now, count };
  if (count !== null) lastGood = count;
  // A failure must not discard a number we already showed — a stale count beats
  // the CTA losing its badge entirely.
  return count ?? lastGood;
}
