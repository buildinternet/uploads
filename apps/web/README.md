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
src/layouts/                         Shared shells (error pages)
src/pages/                           Astro pages; g/[id].astro is the on-demand public gallery
src/lib/                             Public gallery API schema/fetch boundary
public/_headers                      Per-path response headers (Link, robots, types)
public/robots.txt                    Crawl policy + Content Signals + AI bot rules
public/sitemap.xml                   Public URL list (landing only)
public/llms.txt                      Agent-oriented product summary
public/auth.md                       Agent enrollment / bearer auth (not OAuth)
public/.well-known/api-catalog       RFC 9727 linkset
public/.well-known/openapi.json      Summary OpenAPI for the REST API
public/.well-known/mcp/              MCP server card (points at agents.uploads.sh)
src/worker.ts                        Live agent-skills index implementation
astro.config.mjs                     Site URL + Cloudflare hybrid rendering
wrangler.jsonc                       Hybrid Worker, static assets, skills index, API origin
```

## Crawl / index policy

Only the landing page is meant for search engines. Agent discovery docs are public
but not listed in the sitemap.

| Path                                      | Indexable | Notes                                                    |
| ----------------------------------------- | --------- | -------------------------------------------------------- |
| `/`                                       | yes       | Listed in `sitemap.xml`; Link headers advertise catalogs |
| `/invite`                                 | **no**    | Magic-link enrollment; robots + meta + `X-Robots-Tag`    |
| `/console`                                | **no**    | Operator scaffold; same triple coverage                  |
| `/404`,`/500`                             | **no**    | Status pages                                             |
| `/auth.md`, `/llms.txt`, `/.well-known/*` | n/a       | Machine-readable; not in sitemap                         |

`robots.txt` includes explicit `User-agent` blocks for common AI crawlers and
`Content-Signal` preferences (`search=yes`, `ai-input=yes`, `ai-train=no`).

**Note:** Cloudflare AI Crawl Control can rewrite zone-level `robots.txt`. After
deploy, confirm `https://uploads.sh/robots.txt` still shows our `User-agent`
blocks (not only the Content Signals preamble). If the zone override wins, either
disable AI Crawl Control's robots management for this zone or mirror the same
rules there.

## Agent discovery (easy wins)

| Check           | Location                                 |
| --------------- | ---------------------------------------- |
| robots.txt      | `/robots.txt`                            |
| sitemap         | `/sitemap.xml` (referenced from robots)  |
| Link headers    | homepage `/` via `_headers`              |
| API catalog     | `/.well-known/api-catalog`               |
| MCP server card | `/.well-known/mcp/server-card.json`      |
| Agent skills    | `/.well-known/agent-skills/index.json`   |
| Auth for agents | `/auth.md` (bearer / invite — not OAuth) |

### Agent skills — always track GitHub `main`

Canonical skill files live only under the monorepo root:

```
skills/uploads-cli/SKILL.md
```

Per the [Agent Skills Discovery RFC](https://github.com/cloudflare/agent-skills-discovery-rfc),
skill `url` values may be absolute. The discovery **index** is on this origin;
the skill **artifact** is always the latest file on GitHub `main`:

```
GET https://uploads.sh/.well-known/agent-skills/index.json
  → served on demand through Astro by apps/web/src/worker.ts
  → url:    https://raw.githubusercontent.com/buildinternet/uploads/main/skills/uploads-cli/SKILL.md
  → digest: sha256 of those bytes, computed when the index is requested
```

Editing a skill and merging to `main` is enough — no web redeploy is required for
the index URL or digest to stay correct. Responses cache for 60 seconds. To
advertise another skill, append its monorepo path in `SKILL_SOURCES` in
`src/worker.ts` (that _does_ need a web deploy, once).

Use Astro dev or preview to exercise the on-demand index locally.

### Intentionally not implemented (yet)

| Item                            | Why                                                                |
| ------------------------------- | ------------------------------------------------------------------ |
| OAuth/OIDC well-known + PRM     | Auth is invitation bearer tokens, not OAuth                        |
| DNS-AID SVCB records            | DNS / DNSSEC operator work, not this deployable                    |
| Markdown `Accept` negotiation   | Cloudflare zone “Markdown for Agents” feature                      |
| WebMCP `navigator.modelContext` | Experimental browser API; no product tools on the landing page yet |

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
