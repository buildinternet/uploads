/**
 * Guard for the `/internal/*` API (plan D1): endpoints Better Auth doesn't
 * expose directly (e.g. `promote-admin`) that only `apps/api` should be able
 * to reach, over the `AUTH` service binding.
 *
 * Defense-in-depth check, not the only line of defense: a service-binding
 * `fetch()` call never traverses the Cloudflare edge, so `cf-connecting-ip`
 * (set by the edge on every request that *does* traverse it) is always
 * absent on a real binding call and always present on a real public request.
 * We additionally require an explicit `x-uploads-internal: 1` header so a
 * request can't pass this guard by simply omitting one header — the caller
 * has to affirmatively mark itself internal. Neither check alone is a secret;
 * together they mean a public caller would need to both know to send the
 * header AND get a request to this worker that never touched the edge, which
 * isn't possible from outside Cloudflare's network.
 *
 * ⚠ assumption: this relies on Cloudflare continuing to omit
 * `cf-connecting-ip` on service-binding `fetch()` calls and to always set it
 * on edge-routed requests. If that ever changes, this guard needs revisiting
 * (e.g. a shared-secret header instead).
 */
export function isInternalRequest(req: Request): boolean {
  const internalHeader = req.headers.get("x-uploads-internal");
  const hasCfConnectingIp = req.headers.has("cf-connecting-ip");
  return internalHeader === "1" && !hasCfConnectingIp;
}
