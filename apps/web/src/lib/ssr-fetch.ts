/** Identifies SSR HTTP fallbacks to the public edge's bot protection. */
export const SSR_USER_AGENT = "uploads-web (+https://uploads.sh; SSR)";

/** Optional bindings keep local HTTP development and pre-rollout deployments working. */
export interface PublicApiFetchEnv {
  API?: Fetcher;
  PUBLIC_VIEWER?: Fetcher;
  /** Start with files; enable collections only after combined-bundle measurements. */
  PUBLIC_VIEWER_ROLLOUT?: string;
}

/**
 * Select the independent viewer for enabled public reads. API remains the
 * fallback, including for authenticated actions and unknown paths. The URL,
 * encoded key, query, request options, and response pass through unchanged.
 * Removing the binding or setting the rollout to off restores the API path.
 */
export function publicApiFetch(env: PublicApiFetchEnv): typeof globalThis.fetch {
  const fallback = env.API
    ? (env.API.fetch.bind(env.API) as unknown as typeof globalThis.fetch)
    : globalThis.fetch;
  const viewer = env.PUBLIC_VIEWER;
  const rollout = env.PUBLIC_VIEWER_ROLLOUT;
  if (!viewer || (rollout !== "files" && rollout !== "all")) return fallback;

  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const enabled =
      url.pathname.startsWith("/public/files/") ||
      (rollout === "all" && /^\/public\/(feeds|galleries)\//.test(url.pathname));
    if (enabled && (method === "GET" || method === "HEAD")) {
      return viewer.fetch(input, init) as unknown as Promise<Response>;
    }
    return fallback(input, init);
  };
}
