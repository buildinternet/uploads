/**
 * /changelog.xml — Atom twin of /changelog. Prerendered at build time and
 * served off the ASSETS binding; headers come from public/_headers. This is
 * the Tier-1 machine locator declared in .well-known/releases.json.
 */
import type { APIRoute } from "astro";
import { loadChangelogEntries } from "../lib/changelog";
import { renderAtomFeed } from "../lib/changelog-feed";

export const prerender = true;

export const GET: APIRoute = async () => {
  const entries = await loadChangelogEntries();
  return new Response(renderAtomFeed(entries), {
    headers: { "content-type": "application/atom+xml; charset=utf-8" },
  });
};
