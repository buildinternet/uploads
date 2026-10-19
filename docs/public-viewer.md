# Public viewer Worker

The optional `uploads-viewer` Worker serves the public file, live-link and
gallery routers (`src/viewer.ts`) without the rest of the API: no write routes,
no PDF renderer, no WASM. It shares the API's handlers and TypeScript program,
so it lives in `apps/api` with its own config, `wrangler.viewer.jsonc`. The API
keeps its public routes for existing clients and rollback.

Why: public page loads paid for the full API bundle (~8.9 MB with WASM). On
staging, the first file-metadata read after a deploy dropped from a 233 ms to a
149 ms median through the viewer. Warm reads were unchanged, and 100-item
galleries were mixed because storage HEAD hydration dominates them.

## Rollout switch

Only the web Worker's SSR fetches use the viewer. Browser requests to
`api.uploads.sh/public/*`, including download links, stay on the API.

| `PUBLIC_VIEWER_ROLLOUT`         | Public SSR reads                                          |
| ------------------------------- | --------------------------------------------------------- |
| `off`, missing, or unrecognized | API binding, then HTTP fallback                           |
| `files`                         | Files through `PUBLIC_VIEWER`; feeds and galleries on API |
| `all`                           | Files, feeds and galleries through `PUBLIC_VIEWER`        |

Without the `PUBLIC_VIEWER` binding, every setting uses the API. Only GET/HEAD
public reads switch; there is no retry through the API on a viewer error.

## Bindings and secrets

Keep the viewer's registry, D1, GitHub cache, live-link index and R2 bindings
identical to the API's, including every bucket a workspace's fallback lane can
name. `pnpm viewer:bundle:check` fails on R2, KV, D1 or var drift. It cannot
tell when a public path starts needing a binding the viewer lacks (Flagship,
for one), so add it to `wrangler.viewer.jsonc` in the same change.

Provision the same `WORKSPACE_SECRETS_KEY` (and `_PREVIOUS` during rotation)
and `GITHUB_APP_PRIVATE_KEY` as the API. Without the GitHub key, public titles
degrade.

## Deploy

1. Run `pnpm types`, `pnpm typecheck`, `pnpm test` and `pnpm viewer:bundle:check`.
2. Provision the viewer secrets and deploy with `pnpm run deploy:viewer`. It
   runs no migrations; the API owns the schema.
3. Add `{ "binding": "PUBLIC_VIEWER", "service": "uploads-viewer" }` to the
   web Worker's `services`, set the switch to `files`, and deploy web.
4. Move to `all` once file pages look right.

Workers Builds: connect a separate project for `uploads-viewer` with root
directory `apps/api`, no build command, deploy command `pnpm run deploy:viewer`,
and non-production branch builds off. Watch `apps/api/src/**`,
`apps/api/wrangler.viewer.jsonc`, `apps/api/package.json`, `pnpm-lock.yaml`
and the packages the viewer links (`packages/{errors,observability,comment-render,billing,storage}/**`);
exclude `apps/api/test/**` and `apps/api/migrations/**`.

Service bindings always target the viewer's production deployment, so a web
preview cannot test a branch viewer. Test branches against a separately named
staging viewer with preview-tier resources, never production state.

## Bundle check

`pnpm viewer:bundle:check` builds the real viewer and fails if it links the API
entrypoint, owner routes, the classifier, PDF/poster generation, image codecs
or any `.wasm`. It also caps uncompressed JavaScript at 2,000,000 bytes as a
size-regression guard.

## Rollback

Set `PUBLIC_VIEWER_ROLLOUT` to `off` (or remove the binding) and redeploy web.
The viewer adds no cache or data, so nothing else needs undoing.
