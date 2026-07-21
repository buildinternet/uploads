import { describe, expect, it } from "vitest";
import { planTitleRepaint, renderConnectedWorkHtml, renderDetailsHtml } from "./workspace-rail";
import type { GhWorkItem } from "./gh-context";

function ghItem(overrides: Partial<GhWorkItem> = {}): GhWorkItem {
  return {
    repo: "buildinternet/uploads",
    kind: "pull",
    number: "1789",
    ref: "buildinternet/uploads#1789",
    url: "https://github.com/buildinternet/uploads/pull/1789",
    label: "buildinternet/uploads#1789",
    kindLabel: "pull request",
    ...overrides,
  };
}

describe("renderConnectedWorkHtml", () => {
  it("returns an empty string for no items", () => {
    expect(renderConnectedWorkHtml([])).toBe("");
  });

  it("renders a pull-request row with the label link and a kind icon (no subtitle)", () => {
    const html = renderConnectedWorkHtml([ghItem()]);
    expect(html).toContain('href="https://github.com/buildinternet/uploads/pull/1789"');
    expect(html).toContain(">buildinternet/uploads#1789<");
    expect(html).toContain("ws-rail__connected-item");
    // The octicon carries the kind (title/aria-label); no repeated word subtitle.
    expect(html).not.toContain("ws-rail__connected-sub");
    expect(html).toContain("<title>pull request</title>");
  });

  it("uses a different icon for issue rows than pull-request rows", () => {
    const pullHtml = renderConnectedWorkHtml([ghItem()]);
    const issueHtml = renderConnectedWorkHtml([
      ghItem({
        kind: "issue",
        number: "1740",
        ref: "buildinternet/uploads#1740",
        url: "https://github.com/buildinternet/uploads/issues/1740",
        label: "buildinternet/uploads#1740",
        kindLabel: "issue",
      }),
    ]);
    expect(issueHtml).toContain(">issue<");
    expect(issueHtml).not.toBe(pullHtml);
    // Different octicon path data per kind.
    const pullIconPath = pullHtml.match(/<path[^>]* d="([^"]+)"/)?.[1];
    const issueIconPath = issueHtml.match(/<path[^>]* d="([^"]+)"/)?.[1];
    expect(pullIconPath).toBeTruthy();
    expect(issueIconPath).toBeTruthy();
    expect(pullIconPath).not.toBe(issueIconPath);
  });

  it("renders one row per item, in order", () => {
    const html = renderConnectedWorkHtml([
      ghItem(),
      ghItem({
        kind: "issue",
        number: "1740",
        ref: "buildinternet/uploads#1740",
        url: "https://github.com/buildinternet/uploads/issues/1740",
        label: "buildinternet/uploads#1740",
        kindLabel: "issue",
      }),
    ]);
    expect(html.indexOf("#1789")).toBeLessThan(html.indexOf("#1740"));
    expect((html.match(/ws-rail__connected-item/g) ?? []).length).toBe(2);
  });

  it("escapes interpolated label/url/kindLabel", () => {
    const html = renderConnectedWorkHtml([
      ghItem({
        label: '<script>alert("x")</script>',
        url: 'https://github.com/x/y"><script>alert(1)</script>',
        kindLabel: "pull request",
      }),
    ]);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("renderDetailsHtml", () => {
  it("renders the base url as plain host text when the URL is known", () => {
    const html = renderDetailsHtml({
      organization: { slug: "buildinternet" },
      hasPublicUrl: true,
      publicBaseUrl: "https://storage.uploads.sh/",
    });
    expect(html).toContain(">buildinternet<");
    expect(html).not.toContain("your role");
    expect(html).toContain(">base url<");
    expect(html).toContain(">storage.uploads.sh<");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("href=");
    expect(html).not.toContain(">configured<");
  });

  it("falls back to 'configured' when an older API sends only the boolean", () => {
    const html = renderDetailsHtml({
      organization: { slug: "buildinternet" },
      hasPublicUrl: true,
    });
    expect(html).toContain(">configured<");
    expect(html).not.toContain("<a");
  });

  it("escapes an interpolated base url", () => {
    const html = renderDetailsHtml({
      organization: { slug: "acme" },
      hasPublicUrl: true,
      publicBaseUrl: 'https://x.example/"><script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders an em-dash for base url when hasPublicUrl is false", () => {
    const html = renderDetailsHtml({
      organization: { slug: "side-project" },
      hasPublicUrl: false,
    });
    expect(html).toContain(">—<");
    expect(html).not.toContain(">configured<");
  });

  it("escapes interpolated slug", () => {
    const html = renderDetailsHtml({
      organization: { slug: '<img src=x onerror="alert(1)">' },
      hasPublicUrl: false,
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("planTitleRepaint", () => {
  it("returns relabeled items when any fetched title changes a label", () => {
    const items = [ghItem()];
    const out = planTitleRepaint(items, {
      "buildinternet/uploads#1789": { title: "Real title", state: "open", kind: "pull" },
    });
    expect(out?.[0].label).toBe("Real title");
  });

  it("returns null when nothing changed or the fetch failed", () => {
    const items = [ghItem()];
    expect(planTitleRepaint(items, null)).toBeNull();
    expect(planTitleRepaint(items, {})).toBeNull();
    expect(
      planTitleRepaint(items, {
        "buildinternet/uploads#1789": {
          title: "buildinternet/uploads#1789",
          state: "open",
          kind: "pull",
        },
      }),
    ).toBeNull();
  });
});
