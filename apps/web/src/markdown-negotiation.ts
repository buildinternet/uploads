/**
 * Accept: text/markdown content negotiation for the uploads.sh web origin.
 *
 * Cloudflare zone “Markdown for Agents” needs Pro+; this Worker-side path
 * provides the same contract on Free: agents that prefer text/markdown get a
 * markdown body, browsers keep HTML.
 *
 * Note: ASSETS / platform Responses often have immutable headers, so we always
 * clone into a new Headers map before writing Vary or Content-Type.
 *
 * @see https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/
 * @see https://isitagentready.com/.well-known/agent-skills/markdown-negotiation/SKILL.md
 */
import { buildContentSignalHeader, convert } from "markdown-for-agents";

const SITE = "https://uploads.sh";

/**
 * Matches robots.txt Content-Signal preferences: search + agent input OK,
 * training opted out.
 */
const CONTENT_SIGNAL = buildContentSignalHeader({
  search: true,
  aiInput: true,
  aiTrain: false,
});

const CONVERT_OPTIONS = {
  extract: true,
  baseUrl: SITE,
} as const;

function wantsMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  return accept.toLowerCase().includes("text/markdown");
}

function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  return type === "text/html" || type === "application/xhtml+xml";
}

function withVaryAccept(headers: Headers): Headers {
  const out = new Headers(headers);
  const existing = out.get("Vary");
  if (!existing) {
    out.set("Vary", "Accept");
    return out;
  }
  const tokens = existing.split(",").map((s) => s.trim().toLowerCase());
  if (!tokens.includes("accept")) {
    out.set("Vary", `${existing}, Accept`);
  }
  return out;
}

/**
 * Wrap an HTML-producing handler. When Accept includes text/markdown and the
 * upstream body is HTML, convert and set Content-Type + x-markdown-tokens.
 * Non-HTML responses (JSON, plain text, already-markdown) pass through.
 */
export async function withMarkdownNegotiation(
  request: Request,
  next: (request: Request) => Response | Promise<Response>,
): Promise<Response> {
  const response = await next(request);
  const contentType = response.headers.get("Content-Type");
  const html = isHtmlContentType(contentType);
  const preferMarkdown = wantsMarkdown(request.headers.get("Accept"));

  // Non-HTML (JSON, CSS, fonts, pre-built markdown): pass through unchanged.
  // HTML without a markdown preference: re-emit with mutable headers + Vary so
  // caches key HTML and markdown variants separately (ASSETS headers are often immutable).
  if (!html) return response;
  if (!preferMarkdown) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: withVaryAccept(response.headers),
    });
  }

  const htmlBody = await response.text();
  const { markdown, tokenEstimate, contentHash } = convert(htmlBody, CONVERT_OPTIONS);

  const headers = withVaryAccept(response.headers);
  headers.set("Content-Type", "text/markdown; charset=utf-8");
  headers.set("x-markdown-tokens", String(tokenEstimate.tokens));
  headers.set("ETag", `"${contentHash}"`);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  if (CONTENT_SIGNAL) {
    headers.set("Content-Signal", CONTENT_SIGNAL);
  }

  return new Response(markdown, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
