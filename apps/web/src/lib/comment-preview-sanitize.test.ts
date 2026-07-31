import { describe, expect, it } from "vitest";
import {
  formatCommentPreviewBody,
  renderCommentPreviewHtml,
  sanitizeCommentPreviewHtml,
} from "./comment-preview-sanitize";

describe("sanitizeCommentPreviewHtml", () => {
  it("passes through allowed tags with allowed attributes unchanged", () => {
    const html =
      '<p>See <a href="https://uploads.sh/f/abc">this file</a></p>' +
      '<img src="https://uploads.sh/x.png" alt="screenshot" width="640" align="left">';
    expect(sanitizeCommentPreviewHtml(html)).toBe(html);
  });

  it("keeps details/summary and the boolean open attribute", () => {
    const html = "<details open><summary>More</summary><p>Body</p></details>";
    expect(sanitizeCommentPreviewHtml(html)).toBe(html);
  });

  it("keeps table markup and inline formatting tags", () => {
    const html =
      "<table><tr><td><strong>Bold</strong> <em>em</em> <sub>sub</sub> <code>code</code></td></tr></table>" +
      "<h3>H3</h3><h4>H4</h4><ul><li>one</li></ul><br>";
    expect(sanitizeCommentPreviewHtml(html)).toBe(html);
  });

  it("strips script tags and their content entirely", () => {
    const html = "<p>hi</p><script>alert(1)</script><p>bye</p>";
    expect(sanitizeCommentPreviewHtml(html)).toBe("<p>hi</p><p>bye</p>");
  });

  it("strips disallowed tags but keeps their text content", () => {
    const html = "<div>keep me</div><p>ok</p>";
    expect(sanitizeCommentPreviewHtml(html)).toBe("keep me<p>ok</p>");
  });

  it("drops disallowed attributes such as onerror and style", () => {
    const html = '<img src="https://uploads.sh/x.png" onerror="alert(1)" style="x">';
    expect(sanitizeCommentPreviewHtml(html)).toBe('<img src="https://uploads.sh/x.png">');
  });

  it("drops javascript: and data: hrefs/srcs, keeps http(s) and relative", () => {
    expect(sanitizeCommentPreviewHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeCommentPreviewHtml('<img src="data:text/html,evil">')).toBe("<img>");
    expect(sanitizeCommentPreviewHtml('<a href="/f/abc">x</a>')).toBe('<a href="/f/abc">x</a>');
  });

  it("rejects a non-numeric width and a bogus align value", () => {
    expect(sanitizeCommentPreviewHtml('<img src="https://a/b.png" width="9999px">')).toBe(
      '<img src="https://a/b.png">',
    );
    expect(sanitizeCommentPreviewHtml('<img src="https://a/b.png" align="evil()">')).toBe(
      '<img src="https://a/b.png">',
    );
  });

  it("escapes stray angle brackets that are not part of a tag", () => {
    expect(sanitizeCommentPreviewHtml("a < b and c > d")).toBe("a &lt; b and c &gt; d");
  });

  it("handles an empty string", () => {
    expect(sanitizeCommentPreviewHtml("")).toBe("");
  });

  it("closes disallowed nested tags without corrupting sibling allowed tags", () => {
    const html = "<div><p>text</p></div><p>after</p>";
    expect(sanitizeCommentPreviewHtml(html)).toBe("<p>text</p><p>after</p>");
  });

  // Embedded tab/newline/CR bypass (browsers strip these before scheme-
  // sniffing a URL, so a naive `.trim()`-only scheme check can be fooled
  // into treating `javascript:` as a harmless relative URL).
  it("rejects a javascript: href with an embedded tab breaking up the scheme", () => {
    expect(sanitizeCommentPreviewHtml('<a href="java\tscript:alert(1)">x</a>')).toBe("<a>x</a>");
  });

  it("rejects a javascript: href with an embedded newline breaking up the scheme", () => {
    expect(sanitizeCommentPreviewHtml('<a href="java\nscript:alert(1)">x</a>')).toBe("<a>x</a>");
  });

  it("rejects a javascript: href with a leading tab before the scheme", () => {
    expect(sanitizeCommentPreviewHtml('<a href="\tjavascript:alert(1)">x</a>')).toBe("<a>x</a>");
  });

  it("rejects a data: src with an embedded newline inside the scheme-adjacent text", () => {
    expect(sanitizeCommentPreviewHtml('<img src="data:text/html,\nevil">')).toBe("<img>");
  });
});

describe("formatCommentPreviewBody", () => {
  it("strips the hidden managed-comment marker (an HTML comment)", () => {
    const raw = "<!-- uploads.sh:attachments ws=acme -->\n\nHello";
    expect(formatCommentPreviewBody(raw)).not.toContain("uploads.sh:attachments");
    expect(formatCommentPreviewBody(raw)).toBe("<p>Hello</p>");
  });

  it("strips a multiline HTML comment", () => {
    const raw = "<!--\nmulti\nline\n-->\nHello";
    expect(formatCommentPreviewBody(raw)).toBe("<p>Hello</p>");
  });

  it("converts a line-start ### heading to <h3>", () => {
    expect(formatCommentPreviewBody("### 📎 Attachments")).toBe("<h3>📎 Attachments</h3>");
  });

  it("converts a line-start #### heading to <h4>, keeping embedded HTML intact (no double-escaping)", () => {
    const raw = '#### <a href="https://uploads.sh/g/1">My gallery</a>';
    expect(formatCommentPreviewBody(raw)).toBe(
      '<h4><a href="https://uploads.sh/g/1">My gallery</a></h4>',
    );
  });

  it("converts a `- [text](url)` line into a real list item link", () => {
    expect(formatCommentPreviewBody("- [Docs](https://uploads.sh/docs)")).toBe(
      '<ul><li><a href="https://uploads.sh/docs">Docs</a></li></ul>',
    );
  });

  it("keeps a caption suffix on list items and turns path/state code spans into <code>", () => {
    const raw = "- [build.log](https://uploads.sh/f/build.log) · `/admin` · `error`";
    expect(formatCommentPreviewBody(raw)).toBe(
      '<ul><li><a href="https://uploads.sh/f/build.log">build.log</a> · <code>/admin</code> · <code>error</code></li></ul>',
    );
  });

  it("groups consecutive list lines into one <ul>", () => {
    const raw = "- [One](https://a)\n- [Two](https://b)";
    expect(formatCommentPreviewBody(raw)).toBe(
      '<ul><li><a href="https://a">One</a></li><li><a href="https://b">Two</a></li></ul>',
    );
  });

  it("joins consecutive non-blank lines into one paragraph with <br>, and blank lines separate paragraphs", () => {
    const raw = "line one\nline two\n\nsecond paragraph";
    expect(formatCommentPreviewBody(raw)).toBe(
      "<p>line one<br>line two</p><p>second paragraph</p>",
    );
  });

  it("escapes a quote-breakout attempt in a `- [text](url)` line's URL so it stays one attribute, safe standalone", () => {
    // Before the item[2]/item[1] escaping fix, the raw `"` in the URL broke
    // out of the href attribute here, producing a second, genuine
    // `onmouseover="foo"` attribute in formatCommentPreviewBody's own
    // output — exploitable if that output were ever used without the
    // sanitize pass. Escaping at construction keeps it one href value.
    const raw = '- [x](javascript:evil" onmouseover="foo)';
    const out = formatCommentPreviewBody(raw);
    expect(out).toBe(
      '<ul><li><a href="javascript:evil&quot; onmouseover=&quot;foo">x</a></li></ul>',
    );
  });

  it("does not double-escape a line that is already an HTML tag", () => {
    const raw = '<a href="https://uploads.sh/f/x"><img src="https://uploads.sh/x.png"></a>';
    const out = formatCommentPreviewBody(raw);
    expect(out).not.toContain("&lt;a");
    expect(out).toBe(`<p>${raw}</p>`);
  });

  it("handles an empty string", () => {
    expect(formatCommentPreviewBody("")).toBe("");
  });
});

describe("renderCommentPreviewHtml (format + sanitize combined)", () => {
  it("renders a realistic managed-comment body: marker gone, heading real, image kept, footer joined", () => {
    const raw =
      "<!-- uploads.sh:attachments ws=acme -->\n" +
      "### 📎 Attachments\n\n" +
      '<a href="https://uploads.sh/f/x"><img width="720" alt="x.png" src="https://embed.uploads.sh/x.png"></a>\n' +
      "<sub><code>/settings</code> · <code>after</code></sub>\n\n" +
      "<sub>Maintained by uploads.sh.</sub>\n" +
      "<sub>Add media: <code>uploads put</code></sub>";
    const out = renderCommentPreviewHtml(raw);
    expect(out).not.toContain("uploads.sh:attachments");
    expect(out).toContain("<h3>📎 Attachments</h3>");
    expect(out).toContain('<img width="720" alt="x.png" src="https://embed.uploads.sh/x.png">');
    expect(out).toContain("<sub><code>/settings</code> · <code>after</code></sub>");
    expect(out).toContain(
      "<sub>Maintained by uploads.sh.</sub><br><sub>Add media: <code>uploads put</code></sub>",
    );
  });

  it("still enforces the tag/attribute allowlist after formatting (script stripped, unsafe href dropped)", () => {
    const raw = "### Heading\n\n<script>alert(1)</script>\n\n- [Bad](javascript:evil)";
    const out = renderCommentPreviewHtml(raw);
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("<h3>Heading</h3>");
  });

  it("neutralizes a combined URL-quote-breakout + dangerous-scheme injection in a list-item line", () => {
    expect(renderCommentPreviewHtml('- [x](javascript:evil" onmouseover="foo)')).not.toContain(
      "onmouseover",
    );
  });
});
