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
  it("marks the active workspace and nests Invite for admins", () => {
    const html = renderWorkspacesNavHtml(sample, {
      active: "buildinternet",
      page: "overview",
    });
    expect(html).toContain('href="/account/workspaces/buildinternet"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="/account/workspaces/buildinternet/invite"');
    expect(html).toContain(">Invite<");
    // Non-active memberships do not get an Invite sub-link.
    expect(html).not.toContain("/account/workspaces/side/invite");
  });

  it("marks Invite as the current page and the workspace as location-current", () => {
    const html = renderWorkspacesNavHtml(sample, {
      active: "buildinternet",
      page: "invite",
    });
    expect(html).toMatch(/href="\/account\/workspaces\/buildinternet"[^>]*aria-current="true"/);
    expect(html).toMatch(
      /href="\/account\/workspaces\/buildinternet\/invite"[^>]*aria-current="page"/,
    );
  });

  it("does not offer Invite for non-admin memberships", () => {
    const html = renderWorkspacesNavHtml(sample, { active: "side", page: "overview" });
    expect(html).toContain('href="/account/workspaces/side"');
    expect(html).not.toContain("/account/workspaces/side/invite");
  });
});
