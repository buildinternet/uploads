#!/usr/bin/env node
/**
 * Renders the branded HTML Cloudflare serves for errors it generates itself,
 * before (or instead of) our origin — Worker exceptions, origin timeouts, WAF
 * blocks, rate limits, challenges. Those never reach apps/web, so the Astro
 * 404/500 pages (src/pages/404.astro, 500.astro) can't cover them and visitors
 * get the generic Cloudflare page instead.
 *
 * Usage: node scripts/cf-error-pages/build.mjs   (from the repo root)
 * Output: scripts/cf-error-pages/dist/<page-id>.html
 *
 * Deploying is two more steps, both in ./deploy.mjs:
 *   1. upload each file to the server-owned `_internal/` R2 namespace, which is
 *      publicly fetchable at storage.uploads.sh and hidden from listings
 *      (same pattern as the email mark — see packages/email/src/card.ts);
 *   2. point the zone's Error Pages at those URLs via the Cloudflare API.
 *      Cloudflare fetches and caches the HTML at configuration time, so the
 *      pages keep working even when the origin they're hosted on is the thing
 *      that's down.
 *
 * Hard constraints these pages are built around:
 *   - Fully self-contained. No stylesheet, font, image, or script fetches. A
 *     page shown because uploads.sh is unreachable cannot depend on uploads.sh,
 *     so the @uploads/ui tokens are inlined below and the brand faces degrade
 *     to system stacks rather than loading the self-hosted woff2 files.
 *   - Each page must contain its Cloudflare token verbatim (`required_tokens`
 *     on GET /zones/:zone/custom_pages). Cloudflare rejects the upload without
 *     it. That token is where Cloudflare injects the error detail box, the
 *     Ray ID, or the challenge widget.
 *   - Error Pages do not apply to 500/501/503/505 responses (Cloudflare
 *     excludes them so API endpoints keep their own bodies), which is why our
 *     JSON APIs on api./auth./agents. keep returning JSON errors untouched.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PAGES, RULES } from "./pages.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "dist");

/**
 * Design tokens copied from packages/ui/dist/uploads-ui.css `:root`. Inlined
 * rather than imported because the built page has to stand alone; keep the
 * values in sync with the design system when they change there.
 */
const TOKENS = `
  --bg: #0a0a0b;
  --panel: #121214;
  --line: #232327;
  --fg: #ececea;
  --body: #b3b3ad;
  --muted: #8a8a83;
  --accent: #c27eff;
  /* Brand faces are self-hosted woff2; a standalone page can't fetch them. */
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
`;

/**
 * The chevron mark from apps/web/public/favicon.svg, inlined as markup so it
 * costs no request. `crispEdges` keeps the pixel grid sharp at any size.
 */
const MARK = `<svg class="mark" viewBox="0 0 32 32" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><path d="M4 0H28V4H32V28H28V32H4V28H0V4H4Z" fill="#121214"/><g fill="#c27eff"><path d="M14 4h4v4h-4z M10 6h4v4h-4z M18 6h4v4h-4z M6 8h4v4h-4z M22 8h4v4h-4z"/><path opacity=".55" d="M14 12h4v4h-4z M10 14h4v4h-4z M18 14h4v4h-4z M6 16h4v4h-4z M22 16h4v4h-4z"/><path opacity=".28" d="M14 20h4v4h-4z M10 22h4v4h-4z M18 22h4v4h-4z M6 24h4v4h-4z M22 24h4v4h-4z"/></g></svg>`;

/** Minimal HTML escape for copy — the templates below interpolate plain text. */
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function render(page) {
  // The token is Cloudflare's injection point; it must survive verbatim, so it
  // is written outside `esc()` and given its own styled container.
  const box = page.token ? `\n          <div class="cf-box">${page.token}</div>` : "";
  const hint = page.hint ? `\n          <p class="hint">${esc(page.hint)}</p>` : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow, noarchive" />
    <meta name="theme-color" content="#121214" />
    <title>${esc(page.title)} · uploads.sh</title>
    <style>
      :root {
        color-scheme: dark;${TOKENS}      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        min-height: 100dvh;
        padding: 28px 24px;
        background: var(--bg);
        color: var(--fg);
        font: 14.5px/1.65 var(--mono);
        -webkit-font-smoothing: antialiased;
        display: grid;
        place-items: center;
      }
      .card-wrap {
        width: min(480px, 100%);
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 10px;
        overflow: hidden;
      }
      .titlebar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 14px;
        border-bottom: 1px solid var(--line);
        color: var(--muted);
        font-size: 11px;
        letter-spacing: 0.05em;
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        color: var(--fg);
        text-decoration: none;
      }
      .mark {
        width: 16px;
        height: 16px;
        display: block;
      }
      .body {
        padding: 26px 22px 24px;
      }
      h1 {
        margin: 0 0 12px;
        font: 600 1.15rem/1.35 var(--sans);
        letter-spacing: -0.01em;
        color: var(--fg);
      }
      p {
        margin: 0;
        color: var(--body);
        font: 0.92rem/1.6 var(--sans);
      }
      .hint {
        margin-top: 10px;
        font-size: 0.85rem;
        color: var(--muted);
      }
      /*
       * Cloudflare injects its own markup here: the error detail block (an
       * <h2> carrying the error code and Ray ID, then <p> diagnostics) or the
       * challenge widget. We don't control that markup, so the rules below
       * only neutralize user-agent defaults that would fight the card — an
       * unstyled <h2> lands at 1.5em bold and shouts over the real headline.
       * Nothing here assumes a Cloudflare class name.
       */
      .cf-box {
        margin-top: 20px;
        padding-top: 18px;
        border-top: 1px solid var(--line);
        color: var(--muted);
        font: 12px/1.6 var(--mono);
        overflow-wrap: anywhere;
      }
      .cf-box h1,
      .cf-box h2,
      .cf-box h3 {
        margin: 0 0 8px;
        font: 500 12px/1.6 var(--mono);
        color: var(--body);
        letter-spacing: 0;
      }
      .cf-box p {
        margin: 0 0 6px;
        font: 12px/1.6 var(--mono);
        color: var(--muted);
      }
      .cf-box p:last-child {
        margin-bottom: 0;
      }
      .cf-box a {
        color: var(--muted);
      }
      .actions {
        margin-top: 22px;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .btn {
        display: inline-block;
        font: 12px var(--mono);
        color: var(--muted);
        background: var(--bg);
        border: 1px solid var(--line);
        border-radius: 7px;
        padding: 7px 12px;
        text-decoration: none;
      }
      .btn:hover,
      .btn:focus-visible {
        color: var(--fg);
        border-color: var(--accent);
        outline: none;
      }
    </style>
  </head>
  <body>
    <div class="card-wrap">
      <section class="card" aria-labelledby="error-title">
        <div class="titlebar">
          <a class="brand" href="https://uploads.sh/">${MARK}<span>uploads.sh</span></a>
          <span aria-hidden="true">${esc(page.label)}</span>
        </div>
        <div class="body">
          <h1 id="error-title">${esc(page.title)}</h1>
          <p>${esc(page.message)}</p>${hint}${box}
          <div class="actions">
            <a class="btn" href="https://uploads.sh/">← home</a>
            <a class="btn" href="https://status.uploads.sh/">status</a>
          </div>
        </div>
      </section>
    </div>
  </body>
</html>
`;
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Custom Error Rule bodies render from the same template — they differ only in
// how they reach visitors (a ruleset rule rather than an Error Page slot).
for (const page of [...PAGES, ...RULES]) {
  const html = render(page);
  // Fail loudly here rather than at the Cloudflare API, which rejects a page
  // missing its token with a generic validation error.
  if (page.token && !html.includes(page.token)) {
    throw new Error(`${page.id}: required token ${page.token} missing from rendered output`);
  }
  const file = path.join(outDir, `${page.id}.html`);
  await writeFile(file, html);
  console.log(`wrote ${path.relative(process.cwd(), file)}  ${html.length} bytes`);
}
