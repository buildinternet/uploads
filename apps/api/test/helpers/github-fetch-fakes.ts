/**
 * Shared fetch fakes for the GitHub ingest test suites (github-ingest.test.ts,
 * github-ingest-e2e.test.ts, routes-workspace-github.test.ts). Previously
 * copy-pasted across all three call sites; extracted here so there's one
 * definition to keep in sync.
 */

/** Matches routes by substring against the requested URL, like repo-comment-config.test.ts's fakeFetch. */
export function fakeFetch(
  routes: Record<string, (init: RequestInit) => Response | Promise<Response>>,
) {
  return (async (url: string, init: RequestInit = {}) => {
    for (const [pattern, handler] of Object.entries(routes)) {
      if (String(url).includes(pattern)) return handler(init);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

/** A 200 PNG response, for routing an asset-URL fetch in `fakeFetch`'s route table. */
export function pngRoute(png: Uint8Array): () => Response {
  return () => new Response(png, { status: 200, headers: { "content-type": "image/png" } });
}

/** Swaps `globalThis.fetch` for the duration of `fn` — needed for call sites
 * (repo-comment-config's un-seamed lookup) that aren't reachable via a
 * `fetchImpl` seam. */
export async function withGlobalFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}
