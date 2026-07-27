/**
 * Allowlist sanitizer for the workspace comment-settings preview panel
 * (issue #307, Task 7). The preview endpoint's `body` field is real
 * managed-comment HTML from `attachmentsCommentBody`
 * (apps/api/src/github-comment-render.ts) — safe by construction against
 * *our own* renderer, but it can be influenced by a repo's `.uploads.yml`
 * (the note text, effectively), so the web client never `innerHTML`s it raw.
 *
 * Scoped tightly to the tags/attributes that renderer actually emits — not a
 * general-purpose HTML sanitizer. If the renderer ever grows a new tag or
 * attribute, this allowlist needs a matching update or the preview will
 * silently drop it.
 */

/** Tags the managed-comment renderer emits (github-comment-render.ts) — see repo-comment-config.ts's task 7 brief for the exact list. */
const ALLOWED_TAGS = new Set([
  "a",
  "img",
  "sub",
  "strong",
  "details",
  "summary",
  "table",
  "tr",
  "td",
  "br",
  "h3",
  "h4",
  "code",
  "em",
  "p",
  "ul",
  "li",
]);

/** Tags whose content (not just the tag itself) must never reach the DOM. */
const STRIP_CONTENT_TAGS = new Set([
  "script",
  "style",
  "svg",
  "iframe",
  "object",
  "embed",
  "template",
]);

/** Attributes kept per tag — everything else is dropped, never passed through. */
const ALLOWED_ATTRS_BY_TAG: Record<string, ReadonlySet<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "width", "align"]),
  details: new Set(["open"]),
};

const WIDTH_RE = /^\d{1,4}%?$/;
const ALIGN_RE = /^[A-Za-z]+$/;

const TAG_RE =
  /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function escapeStrayAngles(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttrValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Strip ASCII tab/newline/CR *everywhere* in the value, not just the edges.
 * Browsers do this while parsing `href`/`src` before scheme-sniffing (WHATWG
 * URL parsing's "remove all ASCII tab or newline" step), so a scheme check
 * that only `.trim()`s is bypassable: `"java\tscript:alert(1)"` doesn't match
 * the scheme regex (the embedded tab breaks it), so `isSafeUrl` sees no
 * scheme at all and treats it as a safe relative URL — while the browser
 * strips the tab back out at render time and happily executes it. Applying
 * this to every attribute value (not just href/src) before any per-attribute
 * check keeps width/align consistent with the same normalization.
 */
function stripUrlNoise(value: string): string {
  return value.replace(/[\t\n\r]/g, "");
}

/** http(s) or scheme-less (relative/anchor) URLs only — no `javascript:`/`data:`/anything else. */
function isSafeUrl(value: string): boolean {
  const match = value.trim().match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!match) return true;
  const scheme = match[1].toLowerCase();
  return scheme === "http" || scheme === "https";
}

function filterAttributes(tagName: string, attrsRaw: string): string {
  const allowed = ALLOWED_ATTRS_BY_TAG[tagName];
  if (!allowed || attrsRaw.trim().length === 0) return "";

  let out = "";
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrsRaw))) {
    const name = m[1].toLowerCase();
    if (!allowed.has(name)) continue;
    const rawValue = m[2] ?? m[3] ?? m[4];

    if (name === "open") {
      out += " open";
      continue;
    }
    if (rawValue === undefined) continue; // every other allowed attribute requires a value
    const value = stripUrlNoise(rawValue);

    if ((name === "href" || name === "src") && !isSafeUrl(value)) continue;
    if (name === "width" && !WIDTH_RE.test(value)) continue;
    if (name === "align" && !ALIGN_RE.test(value)) continue;

    out += ` ${name}="${escapeAttrValue(value)}"`;
  }
  return out;
}

/**
 * Sanitize a managed-comment preview body down to the tag/attribute
 * allowlist above. Disallowed tags are unwrapped (their text content
 * survives); `script`/`style`/etc. are stripped along with their content.
 * Text outside any tag has stray `<`/`>` escaped so it can never be
 * misread as markup once reassembled.
 */
export function sanitizeCommentPreviewHtml(html: string): string {
  if (!html) return html;

  let result = "";
  let lastIndex = 0;
  let skipUntilCloseTag: string | null = null;

  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(html))) {
    const full = match[0];
    const tagName = match[1].toLowerCase();
    const attrsRaw = match[2] ?? "";
    const isClosing = full.startsWith("</");
    const textBefore = html.slice(lastIndex, match.index);
    lastIndex = match.index + full.length;

    if (skipUntilCloseTag) {
      if (isClosing && tagName === skipUntilCloseTag) skipUntilCloseTag = null;
      continue;
    }

    result += escapeStrayAngles(textBefore);

    if (STRIP_CONTENT_TAGS.has(tagName)) {
      if (!isClosing && !full.endsWith("/>")) skipUntilCloseTag = tagName;
      continue;
    }

    if (!ALLOWED_TAGS.has(tagName)) continue; // unwrap: drop the tag, keep surrounding text

    if (isClosing) {
      result += `</${tagName}>`;
      continue;
    }

    result += `<${tagName}${filterAttributes(tagName, attrsRaw)}>`;
  }

  if (!skipUntilCloseTag) result += escapeStrayAngles(html.slice(lastIndex));
  return result;
}

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const H4_LINE_RE = /^####\s+(.*)$/;
const H3_LINE_RE = /^###\s+(.*)$/;
/** `- [text](url)` — the one markdown-list shape the renderer's note/gallery text can contain. */
const LIST_ITEM_LINE_RE = /^-\s+\[([^\]]*)\]\(([^)]*)\)\s*$/;

/**
 * `attachmentsCommentBody` (apps/api/src/github-comment-render.ts) emits
 * GitHub-flavored Markdown with embedded HTML — literal `### heading` /
 * `#### <a>title</a>` lines alongside real `<table>/<a>/<img>` tags, because
 * GitHub's own renderer understands both together. Nothing in apps/web
 * understands Markdown, so without this step the preview showed the hidden
 * `<!-- uploads.sh:attachments ... -->` marker and literal `###`/`####`
 * text verbatim instead of a heading. This is a *small, scoped* subset of
 * Markdown — exactly what the renderer's own output shape needs (headings,
 * one link-list-item form, paragraph/line breaks) — not a general Markdown
 * parser. It runs BEFORE `sanitizeCommentPreviewHtml`, so nothing it emits
 * skips the allowlist: an `<a href>` built here still has its `href`
 * validated the same as one that arrived as raw HTML.
 */
export function formatCommentPreviewBody(raw: string): string {
  const withoutComments = raw.replace(HTML_COMMENT_RE, "");
  const lines = withoutComments.split(/\r\n|\r|\n/);

  const out: string[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push(`<p>${paragraph.join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (listItems.length === 0) return;
    out.push(`<ul>${listItems.join("")}</ul>`);
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    const h4 = line.match(H4_LINE_RE);
    if (h4) {
      flushParagraph();
      flushList();
      out.push(`<h4>${h4[1].trim()}</h4>`);
      continue;
    }

    const h3 = line.match(H3_LINE_RE);
    if (h3) {
      flushParagraph();
      flushList();
      out.push(`<h3>${h3[1].trim()}</h3>`);
      continue;
    }

    const item = line.match(LIST_ITEM_LINE_RE);
    if (item) {
      flushParagraph();
      // Escape at construction — not just relying on the sanitize pass that
      // runs after — so this transform is safe standalone.
      const href = escapeAttrValue(item[2]);
      const text = escapeStrayAngles(item[1]);
      listItems.push(`<li><a href="${href}">${text}</a></li>`);
      continue;
    }

    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();

  return out.join("");
}

/**
 * The one entry point the settings-tab preview panel should call: strips
 * the managed-comment marker, converts the renderer's Markdown-ish shape to
 * real tags, then sanitizes the result down to the tag/attribute allowlist.
 * Prefer this over calling `formatCommentPreviewBody`/
 * `sanitizeCommentPreviewHtml` separately — they're exported individually
 * only so each transform has its own focused tests.
 */
export function renderCommentPreviewHtml(raw: string): string {
  return sanitizeCommentPreviewHtml(formatCommentPreviewBody(raw));
}
