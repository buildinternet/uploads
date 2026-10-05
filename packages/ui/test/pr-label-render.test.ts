import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrLabel, type PrLabelProps } from "../src/components/pr-label";

function render(props: PrLabelProps): string {
  return renderToStaticMarkup(createElement(PrLabel, props));
}

describe("PrLabel", () => {
  it("renders #n Title with a merge icon and a screen-reader state", () => {
    const html = render({ ghRef: "acme/web#12", title: "Fix login", state: "merged" });
    expect(html).toMatch(/^<span /);
    expect(html).toContain('data-slot="pr-label"');
    expect(html).toContain('data-state="merged"');
    expect(html).toContain("text-primary");
    expect(html).toContain('data-icon="pull-merged"');
    expect(html).toContain(">#12 Fix login<");
    expect(html).toContain('<span class="sr-only"> (pull request, merged)</span>');
  });

  it("picks the icon and token color for each state and kind", () => {
    const open = render({ ghRef: "a/b#1", state: "open" });
    expect(open).toContain("text-success");
    expect(open).toContain('data-icon="pull-open"');
    const closed = render({ ghRef: "a/b#1", state: "closed" });
    expect(closed).toContain("text-destructive");
    expect(closed).toContain('data-icon="pull-closed"');
    expect(render({ ghRef: "a/b#1", kind: "issue", state: "open" })).toContain(
      'data-icon="issue-open"',
    );
    expect(render({ ghRef: "a/b#1", kind: "issue", state: "closed" })).toContain(
      'data-icon="issue-closed"',
    );
    const unknown = render({ ghRef: "a/b#1" });
    expect(unknown).toContain("text-muted-foreground/60");
    expect(unknown).toContain('data-icon="pull-open"');
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
    // Important modifier: beats the app's unlayered global `a` underline.
    expect(html).toContain("no-underline!");
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
