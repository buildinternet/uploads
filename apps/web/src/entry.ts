/**
 * Cloudflare Worker entry for the uploads.sh web app.
 *
 * Wraps the Astro/Cloudflare handler so HTML pages honor Accept: text/markdown
 * (app-level Markdown for Agents — no zone Pro feature required).
 */
import { handle } from "@astrojs/cloudflare/handler";
import { withMarkdownNegotiation } from "./markdown-negotiation";

export default {
  async fetch(request, env, ctx) {
    return withMarkdownNegotiation(request, (req) => handle(req, env, ctx));
  },
} satisfies ExportedHandler<Env>;
