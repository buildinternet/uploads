import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCachedWorkspaces,
  readCachedWorkspaces,
  renderWorkspacesNavHtml,
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
    communal: false,
    hasPublicUrl: true,
  },
  {
    workspace: "side",
    organization: { id: "2", slug: "side", name: "Side Project" },
    role: "member",
    communal: false,
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

describe("renderWorkspacesNavHtml", () => {
  it("renders one flat row per membership and marks the active one", () => {
    const html = renderWorkspacesNavHtml(sample, { active: "buildinternet" });
    expect(html).toContain('href="/account/workspaces/buildinternet"');
    expect(html).toContain('class="side-link"');
    expect(html).toMatch(/href="\/account\/workspaces\/buildinternet"[^>]*aria-current="page"/);
    expect(html).toContain('href="/account/workspaces/side"');
    // Non-active memberships get no aria-current.
    expect(html).not.toMatch(/href="\/account\/workspaces\/side"[^>]*aria-current/);
    // No nested/Invite sub-items in the flat nav.
    expect(html).not.toContain("side-nested");
    expect(html).not.toContain("/invite");
  });

  it("marks no row current when there is no active workspace", () => {
    const html = renderWorkspacesNavHtml(sample);
    expect(html).not.toContain("aria-current");
  });
});
