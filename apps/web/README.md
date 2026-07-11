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
src/layouts/                         Shared shells (error pages)
src/pages/                           Astro pages (index, console, invite, 404, 500)
public/_headers                      Per-path response headers (Link, robots, types)
public/robots.txt                    Crawl policy + Content Signals + AI bot rules
public/sitemap.xml                   Public URL list (landing only)
public/llms.txt                      Agent-oriented product summary
public/auth.md                       Agent enrollment / bearer auth (not OAuth)
public/.well-known/api-catalog       RFC 9727 linkset
public/.well-known/openapi.json      Summary OpenAPI for the REST API
public/.well-known/mcp/              MCP server card (points at agents.uploads.sh)
public/.well-known/agent-skills/     Skills discovery index + uploads-cli skill
astro.config.mjs                     site = https://uploads.sh
wrangler.jsonc                       Workers static assets deploy
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

### Keeping the skill digest in sync

When `skills/uploads-cli/SKILL.md` changes, refresh the web copy and digest:

```bash
cp skills/uploads-cli/SKILL.md \
  apps/web/public/.well-known/agent-skills/uploads-cli/SKILL.md
DIGEST=$(shasum -a 256 apps/web/public/.well-known/agent-skills/uploads-cli/SKILL.md | awk '{print $1}')
# set digest to sha256:$DIGEST in apps/web/public/.well-known/agent-skills/index.json
```

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
