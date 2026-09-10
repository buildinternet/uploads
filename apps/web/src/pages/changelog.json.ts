/**
 * /changelog.json — JSON twin of /changelog. Prerendered at build time and
 * served off the ASSETS binding; headers come from public/_headers. The CLI
 * (`uploads changelog`) and MCP `changelog` tool read this.
 */
import type { APIRoute } from "astro";
import { loadChangelogEntries } from "../lib/changelog";
import { renderChangelogJson } from "../lib/changelog-json";

export const prerender = true;

export const GET: APIRoute = async () => {
  const entries = await loadChangelogEntries();
  return new Response(JSON.stringify(renderChangelogJson(entries), null, 2) + "\n", {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
