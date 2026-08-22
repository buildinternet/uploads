/// <reference types="astro/client" />
/// <reference path="../worker-configuration.d.ts" />

// uploads#754 item 3 (minimal-binding profile): AUTH, API, and FLAGS are all
// optional here even though wrangler.jsonc declares them unconditionally.
// This mirrors the apps/api / apps/auth env.d.ts "optional-shadow" pattern —
// required-ness in wrangler.jsonc is a deploy-time guarantee, not a runtime
// one. The actual fail-soft logic already lives in each call site's own
// narrow local type (`AuthProxyEnv` in lib/auth-proxy.ts, `ApiProxyEnv` in
// lib/api-proxy.ts, `FlagshipLike`'s env shape in lib/console-mode.ts); this
// augmentation only centralizes the documentation on the shared `Env` so an
// audit doesn't have to hunt through three files to see which bindings a
// self-hoster may skip. ASSETS is NOT listed here — it is a core binding
// (the site cannot serve without it); see docs/ops.md.
interface Env {
  AUTH?: Fetcher;
  API?: Fetcher;
  FLAGS?: Flagship;
}
