# @uploads/web

Astro site — placeholder landing page for **uploads.sh**. Separate deploy from the API; future home for a browse/manage UI (likely files-sdk's `createFilesRouter` + browser client rather than more hand-rolled REST).

## Commands

```bash
pnpm dev          # astro dev
pnpm build        # static build
pnpm run deploy   # build + wrangler deploy
```

From the repo root: `pnpm dev:web` / `pnpm run deploy:web`.

## Layout

```
src/pages/        Astro pages (currently index.astro only)
astro.config.mjs
wrangler.jsonc    Workers static assets deploy
```
