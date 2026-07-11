# @uploads/web

Astro site for **uploads.sh**. Existing pages remain prerendered; public gallery
routes use Astro's Cloudflare adapter for on-demand rendering.

## Commands

```bash
pnpm dev          # astro dev
pnpm test         # public-gallery fetch/schema tests
pnpm build        # hybrid static + Cloudflare Worker build
pnpm run deploy   # build + wrangler deploy
```

From the repo root: `pnpm dev:web` / `pnpm run deploy:web`.

## Layout

```
src/layouts/      Shared shells (error pages)
src/pages/        Astro pages; g/[id].astro is the on-demand public gallery
src/lib/          Public gallery API schema/fetch boundary
public/_headers   Per-path response headers for Workers assets
astro.config.mjs
wrangler.jsonc    Hybrid Worker + static assets deploy; public API origin var
```

## Error pages

Astro’s built-in conventions ([docs](https://docs.astro.build/en/basics/astro-pages/)):

| Page                          | Role                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `404.astro` → `dist/404.html` | **Missing route.** Host serves it for unknown paths via `assets.not_found_handling: "404-page"` in `wrangler.jsonc`.                                                                                    |
| `500.astro` → `dist/500.html` | **Application error** (something failed, not “URL doesn’t exist”). Branded page at `/500` today; Astro will use this file for SSR render failures once any routes are on-demand (e.g. admin dashboard). |

Shared shell: `ErrorLayout` (landing palette, `noindex`, home link). The **API** still returns JSON envelopes — these HTML pages are for browser traffic on the web origin.

## Public galleries

`/g/<gal_…>` is rendered on demand by the web Worker. It calls only the
unauthenticated exact-ID API endpoint configured by `UPLOADS_API_ORIGIN`; no
workspace token or browser-side API credential is used. Malformed/deleted IDs
return 404, upstream failures return 503, and empty or retention-missing media
remain intentional page states. Gallery pages are public to anyone with their
opaque URL and carry `noindex`, no-referrer, CSP, and frame-blocking headers.
