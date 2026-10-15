/**
 * Cloudflare Worker entry for the uploads.sh web app.
 *
 * Wraps the Astro/Cloudflare handler so HTML pages honor Accept: text/markdown
 * (app-level Markdown for Agents — no zone Pro feature required).
 */
import { handle } from "@astrojs/cloudflare/handler";
import { reportHandledError } from "@uploads/observability";
import { setIssueContext } from "@uploads/observability/issues";
import { registerIssueContextSink } from "./lib/issue-context";
import { withMarkdownNegotiation } from "./markdown-negotiation";
import { respondWebFetchFailure } from "./lib/web-fetch-error";

registerIssueContextSink(setIssueContext);

export default {
  async fetch(request, env, ctx) {
    try {
      return await withMarkdownNegotiation(request, (req) => handle(req, env, ctx));
    } catch (err) {
      reportHandledError(err);
      return respondWebFetchFailure(request, env.ASSETS);
    }
  },
} satisfies ExportedHandler<Env>;
