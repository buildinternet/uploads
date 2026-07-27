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
    const value = m[2] ?? m[3] ?? m[4];

    if (name === "open") {
      out += " open";
      continue;
    }
    if (value === undefined) continue; // every other allowed attribute requires a value

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
