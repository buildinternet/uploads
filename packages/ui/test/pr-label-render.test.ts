import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrLabel, type PrLabelProps } from "../src/components/pr-label";

function render(props: PrLabelProps): string {
  return renderToStaticMarkup(createElement(PrLabel, props));
}

describe("PrLabel", () => {
  it("renders #n Title with a merged dot and a screen-reader state", () => {
    const html = render({ ghRef: "acme/web#12", title: "Fix login", state: "merged" });
    expect(html).toMatch(/^<span /);
    expect(html).toContain('data-slot="pr-label"');
    expect(html).toContain('data-state="merged"');
    expect(html).toContain("bg-primary");
    expect(html).toContain(">#12 Fix login<");
    expect(html).toContain('<span class="sr-only"> (pull request, merged)</span>');
  });

  it("colors the dot from tokens for each state", () => {
    expect(render({ ghRef: "a/b#1", state: "open" })).toContain("bg-success");
    expect(render({ ghRef: "a/b#1", state: "closed" })).toContain("bg-destructive");
    const unknown = render({ ghRef: "a/b#1" });
    expect(unknown).toContain("bg-muted-foreground/60");
    expect(unknown).toContain('data-state="unknown"');
    expect(unknown).toContain('<span class="sr-only"> (pull request)</span>');
  });

  it("names issues and the compact variant for screen readers", () => {
    expect(render({ ghRef: "a/b#1", kind: "issue", state: "closed" })).toContain(
      '<span class="sr-only"> (issue, closed)</span>',
    );
    expect(
      render({ ghRef: "acme/web#3", title: "Fix", state: "open", size: "sm", compact: true }),
    ).toContain('<span class="sr-only"> (Pull request #3 in acme/web: Fix (open))</span>');
  });

  it("falls back to owner/repo #n without a title", () => {
    expect(render({ ghRef: "acme/web#12" })).toContain(">acme/web #12<");
  });

  it("renders a new-tab link with the full accessible name", () => {
    const html = render({
      ghRef: "acme/web#12",
      title: "Fix",
      state: "open",
      href: "https://github.com/acme/web/pull/12",
      target: "_blank",
    });
    expect(html).toMatch(/^<a /);
    expect(html).toContain('href="https://github.com/acme/web/pull/12"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('aria-label="Pull request #12 in acme/web: Fix (open)"');
    expect(html).not.toContain("sr-only");
  });

  it("renders a span, not a link, for an unsafe href", () => {
    const html = render({ ghRef: "acme/web#12", href: "javascript:alert(1)" });
    expect(html).toMatch(/^<span /);
    expect(html).not.toContain("javascript:");
  });

  it("shows only the number when compact", () => {
    const html = render({ ghRef: "acme/web#12", title: "Fix", size: "sm", compact: true });
    expect(html).toContain('<span class="truncate">#12</span>');
    // The title stays out of the visible text; only the sr-only name carries it.
    expect(html.replace(/<span class="sr-only">.*?<\/span>/, "")).not.toContain("Fix");
  });

  it("puts the title first and the number muted at lg", () => {
    const html = render({ ghRef: "acme/web#12", title: "Fix", size: "lg" });
    expect(html).toMatch(/>Fix <span class="[^"]*text-muted-foreground[^"]*">#12<\/span>/);
  });

  it("escapes the title", () => {
    const html = render({ ghRef: "acme/web#12", title: '<img src=x onerror="a">' });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;a&quot;&gt;");
  });
});
