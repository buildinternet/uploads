import { describe, expect, it } from "vitest";
import { renderConnectedWorkHtml, renderDetailsHtml } from "./workspace-rail";
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

  it("renders a pull-request row with the label link and kindLabel subtitle", () => {
    const html = renderConnectedWorkHtml([ghItem()]);
    expect(html).toContain('href="https://github.com/buildinternet/uploads/pull/1789"');
    expect(html).toContain(">buildinternet/uploads#1789<");
    expect(html).toContain('class="ws-rail__connected-sub"');
    expect(html).toContain(">pull request<");
    expect(html).toContain("ws-rail__connected-item");
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
    const pullIconPath = pullHtml.match(/<path d="([^"]+)"/)?.[1];
    const issueIconPath = issueHtml.match(/<path d="([^"]+)"/)?.[1];
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
  it("renders slug, role, and a configured public url", () => {
    const html = renderDetailsHtml({
      organization: { slug: "buildinternet" },
      role: "admin",
      hasPublicUrl: true,
    });
    expect(html).toContain(">buildinternet<");
    expect(html).toContain(">admin<");
    expect(html).toContain('class="ws-rail__dd ws-rail__dd--accent"');
    expect(html).toContain(">configured<");
    expect(html).not.toContain("storage.uploads.sh");
  });

  it("renders an em-dash for public url when hasPublicUrl is false", () => {
    const html = renderDetailsHtml({
      organization: { slug: "side-project" },
      role: "member",
      hasPublicUrl: false,
    });
    expect(html).toContain(">—<");
    expect(html).not.toContain(">configured<");
  });

  it("escapes interpolated slug/role", () => {
    const html = renderDetailsHtml({
      organization: { slug: '<img src=x onerror="alert(1)">' },
      role: "<b>admin</b>",
      hasPublicUrl: false,
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>admin</b>");
    expect(html).toContain("&lt;img");
  });
});
