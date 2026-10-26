import { describe, expect, it } from "vitest";
import { prLabelHtml, prStateIconHtml } from "./pr-label-html";

describe("prLabelHtml", () => {
  it("renders a span with an icon, #n Title, and a screen-reader state", () => {
    const icon = prStateIconHtml("pull", "open");
    expect(icon).toMatch(/^<svg class="pr-label__icon" viewBox="0 0 24 24" /);
    expect(icon).toContain('data-icon="pull-open"');
    expect(prLabelHtml({ ghRef: "acme/web#12", title: "Fix login", state: "open" })).toBe(
      `<span class="pr-label pr-label--md" data-state="open">${icon}<span class="pr-label__text">#12 Fix login</span><span class="pr-label__sr"> (pull request, open)</span></span>`,
    );
  });

  it("falls back to owner/repo #n with an unknown-state icon", () => {
    const html = prLabelHtml({ ghRef: "acme/web#12" });
    expect(html).toContain('data-state="unknown"');
    expect(html).toContain('data-icon="pull-open"');
    expect(html).toContain('<span class="pr-label__text">acme/web #12</span>');
    expect(html).toContain('<span class="pr-label__sr"> (pull request)</span>');
  });

  it("renders a link with the full accessible name and new-tab rel", () => {
    expect(
      prLabelHtml({
        ghRef: "acme/web#12",
        title: "Fix",
        state: "merged",
        size: "sm",
        href: "https://github.com/acme/web/pull/12",
        target: "_blank",
      }),
    ).toBe(
      `<a class="pr-label pr-label--sm" data-state="merged" href="https://github.com/acme/web/pull/12" target="_blank" rel="noopener noreferrer" aria-label="Pull request #12 in acme/web: Fix (merged)">${prStateIconHtml("pull", "merged")}<span class="pr-label__text">#12 Fix</span></a>`,
    );
  });

  it("accepts root-relative hrefs and refuses script and protocol-relative URLs", () => {
    expect(prLabelHtml({ ghRef: "acme/web#12", href: "/account/workspaces/x/files" })).toContain(
      'href="/account/workspaces/x/files"',
    );
    const script = prLabelHtml({ ghRef: "acme/web#12", href: "javascript:alert(1)" });
    expect(script.startsWith("<span")).toBe(true);
    expect(script).not.toContain("javascript:");
    expect(
      prLabelHtml({ ghRef: "acme/web#12", href: "//evil.example/x" }).startsWith("<span"),
    ).toBe(true);
  });

  it("names issues and compact badges for screen readers", () => {
    expect(prLabelHtml({ ghRef: "acme/web#3", kind: "issue", state: "closed" })).toContain(
      '<span class="pr-label__sr"> (issue, closed)</span>',
    );
    expect(prLabelHtml({ ghRef: "acme/web#3", title: "Fix", compact: true })).toContain(
      '<span class="pr-label__sr"> (Pull request #3 in acme/web: Fix)</span>',
    );
  });

  it("splits title and muted number at lg", () => {
    expect(prLabelHtml({ ghRef: "acme/web#12", title: "Fix", size: "lg" })).toContain(
      '<span class="pr-label__text">Fix <span class="pr-label__number">#12</span></span>',
    );
  });

  it("shows only the number when compact", () => {
    const html = prLabelHtml({ ghRef: "acme/web#12", title: "Fix", compact: true });
    expect(html).toContain('<span class="pr-label__text">#12</span>');
    expect(html).not.toContain("#12 Fix");
  });

  it("escapes the title and the class name", () => {
    const html = prLabelHtml({
      ghRef: "acme/web#12",
      title: '<img src=x onerror="a">',
      className: 'x" onclick="y',
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;a&quot;&gt;");
    expect(html).not.toContain('onclick="y');
  });
});
