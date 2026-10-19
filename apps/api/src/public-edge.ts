/** Lightweight dispatcher for the existing api.uploads.sh/public/* URLs. */
export interface PublicEdgeEnv {
  API: Fetcher;
  PUBLIC_VIEWER?: Fetcher;
  PUBLIC_VIEWER_ROLLOUT?: string;
}

function viewerRead(request: Request, rollout: string | undefined): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (rollout !== "files" && rollout !== "all") return false;
  const path = new URL(request.url).pathname;
  if (/^\/public\/files\/[^/]+\/.+/.test(path)) return true;
  return (
    rollout === "all" &&
    (/^\/public\/feeds\/[^/]+(?:\/items\/[^/]+)?$/.test(path) ||
      /^\/public\/galleries\/[^/]+(?:\/items\/[^/]+\/download)?$/.test(path))
  );
}

export default {
  fetch(request: Request, env: PublicEdgeEnv): Promise<Response> {
    const backend =
      env.PUBLIC_VIEWER && viewerRead(request, env.PUBLIC_VIEWER_ROLLOUT)
        ? env.PUBLIC_VIEWER
        : env.API;
    // Preserve URL, body, headers and streaming response. A selected backend's
    // errors must propagate; retrying could conceal a viewer rollout failure.
    return backend.fetch(request);
  },
};
