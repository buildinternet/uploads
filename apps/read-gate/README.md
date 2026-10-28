# @uploads/read-gate

Pass-through Worker (`uploads-read-gate`) for the hosted R2 custom domains.
A host uses it only after that host's zone route is attached. The planned
order is `store.uploads.sh`, then `storage.uploads.sh`, then
`embed.uploads.sh`. As of 2026-10-28 only `store.uploads.sh` is attached.
`storage.uploads.sh` and `embed.uploads.sh` are pending, in that order. The
zone routes on `uploads.sh` are the current set. On an attached host, a
safety hold returns 404. Every other request is `fetch(request)`, so R2
keeps Range, validators, content type, and CORS.

It does not gate private files. Private-repo images stay cookie-less public
reads. It does not run on a bring-your-own-bucket domain. It does not bind
the held bucket.

The D1 `read_gate` table, the one-host-at-a-time cutover, and
`EXTRA_HOSTED_HOSTS` are in
[docs/ops.md](../../docs/ops.md#hosted-read-gate). `wrangler.jsonc` has no
`routes` array, so a deploy does not attach or remove a host.

```bash
pnpm --filter @uploads/read-gate dev     # wrangler dev on :8791
pnpm --filter @uploads/read-gate test
pnpm run deploy:read-gate                # from the repo root
```

Workers Builds deploys from the repo root with no build step. Watch paths
are `apps/read-gate/**`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml`.
Non-production branch builds are off.
