# @uploads/read-gate

Pass-through Worker (`uploads-read-gate`) in front of the hosted R2 custom
domains: `store.uploads.sh`, `storage.uploads.sh`, and `embed.uploads.sh`.
A safety hold returns 404. Every other request is `fetch(request)`, so R2
keeps Range, validators, content type, and CORS.

It does not gate private files. Private-repo images stay cookie-less public
reads. It does not run on a bring-your-own-bucket domain. It does not bind
the held bucket.

`EXTRA_HOSTED_HOSTS` is an optional comma-separated var. Hostnames in it
join the same hosted lane, for example a staging host. An unknown host
still passes through.

The D1 `read_gate` table and the gate behavior are in
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
