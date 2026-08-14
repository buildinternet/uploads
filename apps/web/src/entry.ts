/**
 * Cloudflare Worker entry for the uploads.sh web app.
 *
 * Wraps the Astro/Cloudflare handler so HTML pages honor Accept: text/markdown
 * (app-level Markdown for Agents — no zone Pro feature required).
 */
import { handle } from "@astrojs/cloudflare/handler";
import { withMarkdownNegotiation } from "./markdown-negotiation";
import { respondWebFetchFailure } from "./lib/web-fetch-error";

export default {
  async fetch(request, env, ctx) {
    try {
      return await withMarkdownNegotiation(request, (req) => handle(req, env, ctx));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ event: "web_fetch_failed", message }));
      return respondWebFetchFailure(request, env.ASSETS);
    }
  },
} satisfies ExportedHandler<Env>;
