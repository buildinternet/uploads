import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCachedWorkspaces,
  readCachedWorkspaces,
  renderSwitcherMenuHtml,
  renderWorkspaceSectionNavHtml,
  switcherLabel,
  workspaceTabFromPathname,
  writeCachedWorkspaces,
  WORKSPACES_CACHE_KEY,
} from "./workspaces-nav";
import type { MyWorkspace } from "./api-client";

function installStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  });
  return values;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const sample: MyWorkspace[] = [
  {
    workspace: "buildinternet",
    organization: { id: "1", slug: "buildinternet", name: "buildinternet" },
    role: "admin",
    hasPublicUrl: true,
  },
  {
    workspace: "side",
    organization: { id: "2", slug: "side", name: "Side Project" },
    role: "member",
    hasPublicUrl: false,
  },
];

describe("workspaces cache", () => {
  it("round-trips a membership list through sessionStorage", () => {
    installStorage();
    writeCachedWorkspaces(sample);
    expect(readCachedWorkspaces()).toEqual(sample);
    clearCachedWorkspaces();
    expect(readCachedWorkspaces()).toBeNull();
    expect(sessionStorage.getItem(WORKSPACES_CACHE_KEY)).toBeNull();
  });

  it("drops malformed cache payloads", () => {
    const values = installStorage();
    values.set(WORKSPACES_CACHE_KEY, "{not-json");
    expect(readCachedWorkspaces()).toBeNull();
    values.set(WORKSPACES_CACHE_KEY, JSON.stringify({ workspaces: "nope" }));
    expect(readCachedWorkspaces()).toBeNull();
  });
});

describe("workspaceTabFromPathname", () => {
  it("maps workspace shell paths to tab ids", () => {
    expect(workspaceTabFromPathname("/account/workspaces/buildinternet")).toBe("files");
    expect(workspaceTabFromPathname("/account/workspaces/buildinternet/")).toBe("files");
    expect(workspaceTabFromPathname("/account/workspaces/buildinternet/galleries")).toBe(
      "galleries",
    );
    expect(workspaceTabFromPathname("/account/workspaces/buildinternet/people")).toBe("people");
    expect(workspaceTabFromPathname("/account/workspaces/buildinternet/invite")).toBe("people");
    expect(workspaceTabFromPathname("/account/workspaces/buildinternet/settings")).toBe("settings");
  });

  it("returns empty outside the workspace shell", () => {
    expect(workspaceTabFromPathname("/account")).toBe("");
    expect(workspaceTabFromPathname("/account/workspaces")).toBe("");
    expect(workspaceTabFromPathname("/account/workspaces/new")).toBe("");
    expect(workspaceTabFromPathname("/account/profile")).toBe("");
  });
});

describe("switcherLabel", () => {
  it("prefers the membership display name, falls back to slug or workspaces", () => {
    expect(switcherLabel(sample, "side")).toBe("Side Project");
    expect(switcherLabel(sample, "buildinternet")).toBe("buildinternet");
    expect(switcherLabel(sample, "unknown")).toBe("unknown");
    expect(switcherLabel(sample, "")).toBe("workspaces");
  });
});

describe("renderSwitcherMenuHtml", () => {
  it("lists memberships, marks the active one, and includes new workspace", () => {
    const html = renderSwitcherMenuHtml(sample, { active: "buildinternet" });
    expect(html).toContain('href="/account/workspaces/buildinternet"');
    expect(html).toContain('href="/account/workspaces/side"');
    expect(html).toMatch(/href="\/account\/workspaces\/buildinternet"[^>]*aria-current="true"/);
    expect(html).not.toMatch(/href="\/account\/workspaces\/side"[^>]*aria-current/);
    expect(html).toContain('href="/account/workspaces/new"');
    expect(html).toContain("+ new workspace");
    expect(html).toContain("ws-switcher__sep");
  });

  it("still shows + new workspace with an empty membership list", () => {
    const html = renderSwitcherMenuHtml([]);
    expect(html).toContain('href="/account/workspaces/new"');
    expect(html).toContain("+ new workspace");
    expect(html).not.toContain("ws-switcher__sep");
  });
});

describe("renderWorkspaceSectionNavHtml", () => {
  it("renders section links for an active workspace and marks the tab", () => {
    const html = renderWorkspaceSectionNavHtml("buildinternet", "galleries");
    expect(html).toContain('href="/account/workspaces/buildinternet"');
    expect(html).toContain('href="/account/workspaces/buildinternet/galleries"');
    expect(html).toContain('href="/account/workspaces/buildinternet/people"');
    expect(html).toContain('href="/account/workspaces/buildinternet/settings"');
    expect(html).toMatch(
      /href="\/account\/workspaces\/buildinternet\/galleries"[^>]*aria-current="page"/,
    );
    expect(html).toContain('class="side-link"');
  });

  it("returns empty when no workspace is active", () => {
    expect(renderWorkspaceSectionNavHtml("")).toBe("");
  });
});
