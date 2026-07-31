import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_WORKSPACE_CACHE_KEY,
  clearCachedActiveWorkspace,
  clearCachedWorkspaces,
  readCachedActiveWorkspace,
  readCachedWorkspaces,
  isManageRequest,
  loadWorkspaces,
  MANAGE_WORKSPACES_HREF,
  renderSwitcherMenuHtml,
  renderWorkspaceSectionNavHtml,
  resolveDefaultWorkspace,
  resolveSidebarWorkspace,
  shouldShowTriggerBadge,
  switcherLabel,
  workspaceTabFromPathname,
  writeCachedActiveWorkspace,
  readCachedQuota,
  writeCachedWorkspaces,
  WORKSPACES_CACHE_KEY,
} from "./workspaces-nav";
import type { MyWorkspace } from "./api-client";

function mapStorage() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => {
        values.delete(key);
      },
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    },
  };
}

function installStorage() {
  const session = mapStorage();
  const local = mapStorage();
  vi.stubGlobal("sessionStorage", session.storage);
  vi.stubGlobal("localStorage", local.storage);
  return { session: session.values, local: local.values };
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

  it("round-trips the creation quota alongside the memberships", () => {
    installStorage();
    writeCachedWorkspaces(sample, { used: 3, cap: 3, allowed: false });
    expect(readCachedQuota()).toEqual({ used: 3, cap: 3, allowed: false });
    expect(readCachedWorkspaces()).toEqual(sample);
  });

  it("reads an absent or malformed cached quota as undefined", () => {
    const { session } = installStorage();
    writeCachedWorkspaces(sample);
    expect(readCachedQuota()).toBeUndefined();
    session.set(WORKSPACES_CACHE_KEY, "{not-json");
    expect(readCachedQuota()).toBeUndefined();
  });

  it("drops malformed cache payloads", () => {
    const { session } = installStorage();
    session.set(WORKSPACES_CACHE_KEY, "{not-json");
    expect(readCachedWorkspaces()).toBeNull();
    session.set(WORKSPACES_CACHE_KEY, JSON.stringify({ workspaces: "nope" }));
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
    expect(workspaceTabFromPathname("/account/workspaces/buildinternet/billing")).toBe("billing");
    expect(workspaceTabFromPathname("/account/workspaces/buildinternet/settings")).toBe("settings");
  });

  it("returns empty outside the workspace shell", () => {
    expect(workspaceTabFromPathname("/account")).toBe("");
    expect(workspaceTabFromPathname("/account/workspaces")).toBe("");
    expect(workspaceTabFromPathname("/account/workspaces/new")).toBe("");
    expect(workspaceTabFromPathname("/account/profile")).toBe("");
  });
});

describe("active workspace cache + resolveSidebarWorkspace", () => {
  it("persists last-used in localStorage (and clears session leftovers)", () => {
    const { session, local } = installStorage();
    writeCachedActiveWorkspace("buildinternet");
    expect(readCachedActiveWorkspace()).toBe("buildinternet");
    expect(local.get(ACTIVE_WORKSPACE_CACHE_KEY)).toBe("buildinternet");
    expect(session.get(ACTIVE_WORKSPACE_CACHE_KEY)).toBeUndefined();

    clearCachedActiveWorkspace();
    expect(readCachedActiveWorkspace()).toBe("");
    expect(local.get(ACTIVE_WORKSPACE_CACHE_KEY)).toBeUndefined();
  });

  it("reads a legacy session value so older tabs still resolve", () => {
    const { session, local } = installStorage();
    session.set(ACTIVE_WORKSPACE_CACHE_KEY, "buildinternet");
    expect(local.get(ACTIVE_WORKSPACE_CACHE_KEY)).toBeUndefined();
    expect(readCachedActiveWorkspace()).toBe("buildinternet");
  });

  it("rejects invalid slugs", () => {
    installStorage();
    writeCachedActiveWorkspace("Not_Valid");
    expect(readCachedActiveWorkspace()).toBe("");
    writeCachedActiveWorkspace("new");
    expect(readCachedActiveWorkspace()).toBe("");
  });

  it("prefers the URL and refreshes the last-used cache", () => {
    installStorage();
    writeCachedActiveWorkspace("side");
    expect(resolveSidebarWorkspace("/account/workspaces/buildinternet", "side")).toBe(
      "buildinternet",
    );
    expect(readCachedActiveWorkspace()).toBe("buildinternet");
  });

  it("falls back to last-used cache on personal routes", () => {
    installStorage();
    writeCachedActiveWorkspace("buildinternet");
    expect(resolveSidebarWorkspace("/account/profile", "")).toBe("buildinternet");
    expect(resolveSidebarWorkspace("/account/developers", "side")).toBe("side");
  });

  it("returns empty when nothing is known", () => {
    installStorage();
    expect(resolveSidebarWorkspace("/account/profile", "")).toBe("");
  });
});

describe("loadWorkspaces", () => {
  it("shares one request between concurrent callers and caches the result", async () => {
    installStorage();
    const fetchMock = vi.fn(async () =>
      Response.json({ workspaces: [], workspaceCreate: { used: 3, cap: 3, allowed: false } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([
      loadWorkspaces("http://127.0.0.1:8787"),
      loadWorkspaces("http://127.0.0.1:8787"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    // Cache written once, so later paints don't need their own fetch.
    expect(readCachedQuota()).toEqual({ used: 3, cap: 3, allowed: false });
  });

  it("revalidates on a later call once the first has settled", async () => {
    installStorage();
    const fetchMock = vi.fn(async () => Response.json({ workspaces: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await loadWorkspaces("http://127.0.0.1:8787");
    await loadWorkspaces("http://127.0.0.1:8787");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not poison the cache with a failed load", async () => {
    installStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await loadWorkspaces("http://127.0.0.1:8787");
    expect(readCachedQuota()).toBeUndefined();
    expect(readCachedWorkspaces()).toBeNull();
  });
});

describe("isManageRequest", () => {
  it("recognizes only the deliberate-list marker", () => {
    expect(isManageRequest("?manage=1")).toBe(true);
    expect(isManageRequest("?next=/x&manage=1")).toBe(true);
    expect(isManageRequest("")).toBe(false);
    expect(isManageRequest("?manage=0")).toBe(false);
    expect(isManageRequest("?managed=1")).toBe(false);
  });

  it("matches the href the switcher renders", () => {
    expect(isManageRequest(new URL(MANAGE_WORKSPACES_HREF, "https://x").search)).toBe(true);
  });
});

describe("resolveDefaultWorkspace", () => {
  const multi = [{ workspace: "buildinternet" }, { workspace: "side" }];

  it("picks the only membership, else a valid last-used", () => {
    expect(resolveDefaultWorkspace([{ workspace: "solo" }], "other")).toBe("solo");
    expect(resolveDefaultWorkspace(multi, "side")).toBe("side");
  });

  it("falls back to the first owned workspace when no last-used is stored", () => {
    const roles = [
      { workspace: "invited", role: "member" },
      { workspace: "mine", role: "owner" },
      { workspace: "other", role: "owner" },
    ];
    expect(resolveDefaultWorkspace(roles, "")).toBe("mine");
    // A stale slug the user is no longer a member of takes the same path.
    expect(resolveDefaultWorkspace(roles, "gone")).toBe("mine");
  });

  it("prefers an administered workspace when none is owned", () => {
    const roles = [
      { workspace: "invited", role: "member" },
      { workspace: "runs-it", role: "admin" },
    ];
    expect(resolveDefaultWorkspace(roles, "")).toBe("runs-it");
  });

  it("falls back to the first membership when no role qualifies", () => {
    expect(resolveDefaultWorkspace(multi, "")).toBe("buildinternet");
    expect(
      resolveDefaultWorkspace(
        [
          { workspace: "one", role: "member" },
          { workspace: "two", role: "member" },
        ],
        "",
      ),
    ).toBe("one");
  });

  // `default` used to be skipped here as the communal tenant. That concept is
  // retired (#505) — no workspace is special, including this one. Role order
  // decides, so an owner of `default` and admin elsewhere now lands in
  // `default`. This is the user-visible change the retirement makes.
  it("treats `default` as an ordinary workspace, ranked by role like any other", () => {
    const pair = [
      { workspace: "default", role: "owner" },
      { workspace: "buildinternet", role: "admin" },
    ];
    expect(resolveDefaultWorkspace(pair, "")).toBe("default");
  });

  it("still honours an explicit last-used workspace over role order", () => {
    const pair = [
      { workspace: "default", role: "owner" },
      { workspace: "buildinternet", role: "admin" },
    ];
    expect(resolveDefaultWorkspace(pair, "buildinternet")).toBe("buildinternet");
  });

  it("returns null only when there are no memberships", () => {
    expect(resolveDefaultWorkspace([], "buildinternet")).toBeNull();
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

describe("shouldShowTriggerBadge", () => {
  const withPlans: MyWorkspace[] = [
    { ...sample[0]!, plan: "pro" },
    { ...sample[1]!, plan: "free" },
  ];

  it("shows only for the active workspace's own pro plan", () => {
    expect(shouldShowTriggerBadge(withPlans, "buildinternet")).toBe(true);
    expect(shouldShowTriggerBadge(withPlans, "side")).toBe(false);
  });

  it("is false with no active workspace, an unknown one, or a missing plan", () => {
    expect(shouldShowTriggerBadge(withPlans, "")).toBe(false);
    expect(shouldShowTriggerBadge(withPlans, "unknown")).toBe(false);
    expect(shouldShowTriggerBadge(sample, "buildinternet")).toBe(false);
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

  it("shows a Pro badge only for a pro-plan workspace, never for free/legacy ones", () => {
    const withPlans: MyWorkspace[] = [
      { ...sample[0]!, plan: "pro" },
      { ...sample[1]!, plan: "free" },
    ];
    const html = renderSwitcherMenuHtml(withPlans, { active: "buildinternet" });
    expect(html).toMatch(/buildinternet[\s\S]*?<span class="pro-badge">Pro<\/span>/);
    const sideItem = html.slice(html.indexOf('href="/account/workspaces/side"'));
    expect(sideItem).not.toContain("pro-badge");
  });

  it("omits the badge when plan is absent (older api, legacy workspace)", () => {
    const html = renderSwitcherMenuHtml(sample, { active: "buildinternet" });
    expect(html).not.toContain("pro-badge");
  });

  it("swaps the create row for manage workspaces at the cap", () => {
    const html = renderSwitcherMenuHtml(sample, {
      active: "buildinternet",
      quota: { used: 3, cap: 3, allowed: false },
    });
    expect(html).toContain('href="/account/workspaces?manage=1"');
    expect(html).toContain("manage workspaces");
    expect(html).not.toContain('href="/account/workspaces/new"');
    expect(html).not.toContain("+ new workspace");
  });

  it("keeps the create row below the cap", () => {
    const html = renderSwitcherMenuHtml(sample, {
      active: "buildinternet",
      quota: { used: 2, cap: 3, allowed: true },
    });
    expect(html).toContain("+ new workspace");
    expect(html).not.toContain("manage workspaces");
  });

  it("keeps the create row when the quota is absent (older api)", () => {
    expect(renderSwitcherMenuHtml(sample, { active: "buildinternet" })).toContain(
      "+ new workspace",
    );
  });
});

describe("renderWorkspaceSectionNavHtml", () => {
  it("renders section links for an active workspace and marks the tab", () => {
    const html = renderWorkspaceSectionNavHtml("buildinternet", "galleries");
    expect(html).toContain('href="/account/workspaces/buildinternet"');
    expect(html).toContain('href="/account/workspaces/buildinternet/galleries"');
    expect(html).toContain('href="/account/workspaces/buildinternet/people"');
    expect(html).toContain('href="/account/workspaces/buildinternet/billing"');
    expect(html).toContain('href="/account/workspaces/buildinternet/settings"');
    expect(html).toMatch(
      /href="\/account\/workspaces\/buildinternet\/galleries"[^>]*aria-current="page"/,
    );
    expect(html).toContain('class="side-link"');
  });

  it("returns empty when no workspace is active", () => {
    expect(renderWorkspaceSectionNavHtml("")).toBe("");
  });

  it("marks no tab current when activeTab is empty (personal routes)", () => {
    const html = renderWorkspaceSectionNavHtml("buildinternet", "");
    expect(html).not.toContain('aria-current="page"');
    expect(html).toContain('href="/account/workspaces/buildinternet"');
  });
});
