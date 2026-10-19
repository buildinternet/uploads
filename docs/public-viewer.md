# Public viewer Worker

The optional `uploads-viewer` Worker serves the existing public file, change
feed, and gallery routers. It has an independent entrypoint and bundle. It
never imports the API application, registers write routes, or installs a PDF
renderer. The API retains its public routes for existing clients and rollback.

The viewer lives in `apps/api` so shared handlers stay in the API's TypeScript
program. This avoids introducing a second ambient `Env` into those modules.
It is a separate deployment, with `wrangler.viewer.jsonc` as its configuration.
Do not import the API application into the viewer to reuse middleware.

## Current rollout state

The web configuration sets `PUBLIC_VIEWER_ROLLOUT` to `off` and does not bind
the viewer. This change prepares the split; it does not enable production
traffic or establish a production latency improvement.

`publicApiFetch` selects the viewer only for enabled GET/HEAD public reads.
The switch covers file pages, feed lists and item pagers, gallery pages and
item views, oEmbed, and the iframe player. Authenticated actions continue to
use the API proxy. Request URLs, encoded keys, cursors, and response bodies
pass through unchanged. There is no error-driven retry through the API.

| Setting                         | Public SSR reads                                            |
| ------------------------------- | ----------------------------------------------------------- |
| `off`, missing, or unrecognized | Existing API binding, then HTTP fallback                    |
| `files`                         | File reads through `PUBLIC_VIEWER`; collections through API |
| `all`                           | Files, feeds, and galleries through `PUBLIC_VIEWER`         |

Without `PUBLIC_VIEWER`, every setting retains the existing API/HTTP path.
Local Astro development can therefore keep its existing API origin. Public
file and gallery download URLs remain on the API origin. The optional public
edge dispatcher routes these unchanged URLs to the viewer after a separate
rollout switch is enabled. SSR selection alone does not reroute browser requests.

## Bindings and secrets

Keep the viewer's workspace registry, D1 database, GitHub cache, live-link
index, and storage bindings aligned with the API. Include every R2 binding
that a workspace's active or fallback lane can name. HTTP provider credentials
still resolve through `createStorage()` and the existing encrypted records.

The operator must provision the same `WORKSPACE_SECRETS_KEY` as the API.
During key rotation, also provision `WORKSPACE_SECRETS_KEY_PREVIOUS`.
Preserve `GITHUB_APP_PRIVATE_KEY`, the GitHub App identity variables, and any
`EMBED_PUBLIC_BASE_URL`, timing, or read-timeout overrides used by the API.
Optional GitHub credentials may degrade gracefully, but omitting them would
change production title behavior. Verify public title enrichment before
switching traffic.

Reads can write the existing title cache and hashed feed index. The index is
an accelerator: every request still resolves the live link and rechecks
scope, object visibility, and current holds. No response cache is added.

## Build and deploy order

1. Run `pnpm types`, `pnpm typecheck`, `pnpm test`, and `pnpm viewer:bundle:check`.
2. Provision the viewer secrets and verify its storage bindings.
3. Deploy the viewer with `pnpm run deploy:viewer`.
4. Add `{ "binding": "PUBLIC_VIEWER", "service": "uploads-viewer" }` to the web
   configuration's production `services` list.
5. Keep `PUBLIC_VIEWER_ROLLOUT` off while running contract and timing checks.
6. Set the web switch to `files` and deploy the web Worker.
7. Enable `all` only after collection checks and combined-bundle measurements pass.

The viewer deploy command does not run migrations. Its database schema is
owned by the API. Operators must handle any required migrations separately.
The aggregate deploy command does not deploy or activate the optional viewer.
For Workers Builds, configure a separate project with the repository root as
its working directory and `pnpm run deploy:viewer` as its deploy command.
Include shared API sources and package dependencies in its build watch paths.
Do not rely on independent API and web builds to finish in a particular order.

## Preview isolation

Use `apps/api/wrangler.viewer.jsonc` explicitly for viewer preview commands.
Its preview resources must remain aligned with the API preview tier, never
production workspace state. GitHub public-data cache sharing follows the
existing API policy. Required preview secrets are provisioned separately.

Service bindings target a Worker's production deployment. Binding a web
preview to `uploads-viewer` therefore does not test the branch viewer.
For an integrated branch test, deploy a separate named staging viewer with
preview-tier resources and bind the staging web Worker to that name. Do not
point a staging viewer at production registry, D1, or object storage. The
existing API preview configuration's `UPLOADS` bucket is a shared development
bucket; use a dedicated test workspace and prefix there.

## Measurement and acceptance

See [the isolated staging results](public-viewer-benchmarks.md) for measured
latency, phase breakdowns, and the remaining activation checks.

`pnpm viewer:bundle:check` compiles the actual viewer and rejects linked PDF
WASM, image-generation packages, and private API entrypoints. It also limits
uncompressed JavaScript to 1,600,000 bytes and checks production/preview binding
parity. This is a code-size regression guard, not a
startup-time guarantee. Keep source maps out of the code-size comparison.

Run `pnpm viewer:bundle:measure` for the three incremental local builds. On
this implementation, the initial measurements were 1,405,189 bytes for files,
1,418,667 bytes with galleries, and 1,442,174 bytes with feeds. These are
uncompressed JavaScript sizes from local Wrangler dry runs, not visitor
downloads or live latency results. Generated entrypoint names introduce small
size differences from the actual viewer artifact.

Before enabling traffic, record all of the following against the same commit:

- Incremental bundles: files only, files plus galleries, and all three routers.
- Alternating fresh-deployment API/viewer pairs, with build IDs to reject stale
  responses, plus warm repeats for each surface.
- Matching bindings, compatibility flags, cache state, and GitHub credentials.
- File header/body times and route work; feed scope, index read/write, hashing,
  holds, HEAD hydration, and serialization; gallery fanout and hydration.
- A feed list of 50 items, pager scopes up to 2,000 keys, galleries up to 100
  items, and both index misses and hits. Measure feed list and item detail
  together, as the item page requests both concurrently.
- Equal JSON, status/error behavior, downloads, fresh same-key replacement,
  revoked links, unavailable workspaces, private objects/counterparts, holds,
  provider lanes, existing posters, and public GitHub title behavior.

First-observed requests after deployment are not guaranteed isolate cold
starts. Report medians, ranges, sample counts, and test locations. Do not
transfer the earlier file-only speedup to collections. Keep production
measurements distinct from local tests and dry-run bundles.

## Rollback

Set `PUBLIC_VIEWER_ROLLOUT` to `off` and redeploy web. Removing its viewer
binding also restores API selection. Keep the API's public routes and the
viewer deployment available while verifying rollback. No data migration or
cache invalidation is needed because this split adds no response cache.

## Public download routing

`src/public-edge.ts` is a separate, small dispatcher. It binds the API and,
after provisioning, the viewer. It imports neither application. File and gallery
download hrefs stay unchanged; GET/HEAD public reads select the viewer under
`PUBLIC_VIEWER_ROLLOUT=files|all`. Unsupported paths, methods, and disabled
rollouts go to the API binding. Responses stream through unchanged. A viewer
failure never triggers an API retry.

The checked-in `wrangler.public-edge.jsonc` has no routes, no viewer binding,
and rollout `off`. CI enforces this pending review and an 8 KiB JavaScript
budget. Deploying this inert configuration does not capture production URLs.

After staging results are reviewed, the operator can add the viewer binding
and zone routes for `api.uploads.sh/public/files/*`,
`api.uploads.sh/public/galleries/*`, and `api.uploads.sh/public/feeds/*`.
[Cloudflare routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)
take precedence over a Custom Domain on the same hostname. The explicit API
service binding makes fallback independent of that precedence and avoids a
same-host fetch loop. Validate this arrangement on an isolated hostname first.

Use `pnpm run deploy:public-edge` for this separate deployment. Provision API
and viewer before enabling its routes. Set its switch to `off` or remove its
zone routes to roll back; neither changes the API Custom Domain. Review and
remove CI's temporary inert-config assertion as part of a future activation PR.

Gallery downloads now resolve the same active/fallback storage lane as gallery
display. The selected lane supplies privacy metadata, public URLs, and bytes.
An active private object still masks a public fallback copy. Holds and link
revocation remain fresh checks at download time. Feed item links to raw object
URLs retain their existing contract; this change adds no new feed download API.
