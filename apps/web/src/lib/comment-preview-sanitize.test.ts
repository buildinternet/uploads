import { describe, expect, it } from "vitest";
import { sanitizeCommentPreviewHtml } from "./comment-preview-sanitize";

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
});
