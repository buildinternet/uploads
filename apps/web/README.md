# @uploads/web

Astro site — landing page for **uploads.sh**. Separate deploy from the API; future home for a browse/manage UI (likely files-sdk's `createFilesRouter` + browser client rather than more hand-rolled REST).

## Commands

```bash
pnpm dev          # astro dev
pnpm build        # static build
pnpm run deploy   # build + wrangler deploy
```

From the repo root: `pnpm dev:web` / `pnpm run deploy:web`.

## Layout

```
src/layouts/      Shared shells (error pages)
src/pages/        Astro pages (index, console, invite, 404, 500)
public/_headers   Per-path response headers for Workers assets
public/robots.txt Crawl policy (disallow invite + console)
public/sitemap.xml Public URL list (landing only)
public/llms.txt   Agent-oriented site map / product summary
astro.config.mjs  site = https://uploads.sh
wrangler.jsonc    Workers static assets deploy
```

## Crawl / index policy

Only the landing page is meant for search engines and agent discovery:

| Path          | Indexable | Notes                                                       |
| ------------- | --------- | ----------------------------------------------------------- |
| `/`           | yes       | Listed in `sitemap.xml`; linked from `llms.txt`             |
| `/invite`     | **no**    | Magic-link enrollment; `robots.txt` + meta + `X-Robots-Tag` |
| `/console`    | **no**    | Operator scaffold; same triple coverage as invite           |
| `/404`,`/500` | **no**    | Status pages; disallowed + `noindex`                        |

## Error pages

Astro’s built-in conventions ([docs](https://docs.astro.build/en/basics/astro-pages/)):

| Page                          | Role                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `404.astro` → `dist/404.html` | **Missing route.** Host serves it for unknown paths via `assets.not_found_handling: "404-page"` in `wrangler.jsonc`.                                                                                    |
| `500.astro` → `dist/500.html` | **Application error** (something failed, not “URL doesn’t exist”). Branded page at `/500` today; Astro will use this file for SSR render failures once any routes are on-demand (e.g. admin dashboard). |

Shared shell: `ErrorLayout` (landing palette, `noindex`, home link). The **API** still returns JSON envelopes — these HTML pages are for browser traffic on the web origin.
