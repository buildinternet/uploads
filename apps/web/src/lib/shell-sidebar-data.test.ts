import { describe, expect, it } from "vitest";
import {
  accountNavSections,
  adminNavSections,
  readSidebarDefaultOpen,
  workspaceSwitcherData,
} from "./shell-sidebar-data";
import type { MyWorkspace } from "./api-client";

function ws(workspace: string, name: string, plan?: string): MyWorkspace {
  return {
    workspace,
    organization: { id: `org_${workspace}`, slug: workspace, name },
    role: "owner",
    hasPublicUrl: false,
    ...(plan ? { plan } : {}),
  } as MyWorkspace;
}

const sample = [ws("buildinternet", ""), ws("side", "Side Project")];

describe("readSidebarDefaultOpen", () => {
  it("defaults to open with no cookie header", () => {
    expect(readSidebarDefaultOpen(null)).toBe(true);
    expect(readSidebarDefaultOpen("")).toBe(true);
    expect(readSidebarDefaultOpen(undefined)).toBe(true);
  });

  it("reads a collapsed state", () => {
    expect(readSidebarDefaultOpen("sidebar_state=false")).toBe(false);
    expect(readSidebarDefaultOpen("a=1; sidebar_state=false; b=2")).toBe(false);
    expect(readSidebarDefaultOpen("a=1;  sidebar_state=false ")).toBe(false);
  });

  it("reads an expanded state", () => {
    expect(readSidebarDefaultOpen("sidebar_state=true")).toBe(true);
  });

  it("falls open for a malformed or unrelated cookie", () => {
    expect(readSidebarDefaultOpen("sidebar_state")).toBe(true);
    expect(readSidebarDefaultOpen("sidebar_state=nope")).toBe(true);
    expect(readSidebarDefaultOpen("other=false")).toBe(true);
    // Not a prefix match — `xsidebar_state` is a different cookie.
    expect(readSidebarDefaultOpen("xsidebar_state=false")).toBe(true);
  });
});

describe("accountNavSections", () => {
  it("renders only the personal group off a workspace", () => {
    const sections = accountNavSections({
      pathname: "/account/profile",
      workspace: "",
      section: "profile",
    });
    expect(sections.map((s) => s.label)).toEqual(["Personal"]);
    expect(sections[0]!.items.map((i) => i.label)).toEqual([
      "Account",
      "Developers",
      "Connected apps",
    ]);
    expect(sections[0]!.items[0]!.current).toBe(true);
    expect(sections[0]!.items[1]!.current).toBe(false);
  });

  it("marks the developers row current on its route", () => {
    const sections = accountNavSections({
      pathname: "/account/developers",
      workspace: "",
      section: "developers",
    });
    expect(sections[0]!.items[1]!.current).toBe(true);
  });

  it("adds the workspace group with the active tab marked", () => {
    const sections = accountNavSections({
      pathname: "/account/workspaces/acme/galleries",
      workspace: "acme",
      section: "workspaces",
    });
    expect(sections.map((s) => s.label)).toEqual(["Workspace", "Personal"]);
    const items = sections[0]!.items;
    expect(items.map((i) => i.label)).toEqual([
      "Screenshots",
      "Files",
      "Galleries",
      "People",
      "Billing",
      "Settings",
    ]);
    expect(items.filter((i) => i.current).map((i) => i.label)).toEqual(["Galleries"]);
    expect(items[0]!.href).toBe("/account/workspaces/acme/screenshots");
  });

  it("treats the bare workspace URL as screenshots", () => {
    const sections = accountNavSections({
      pathname: "/account/workspaces/acme",
      workspace: "acme",
      section: "workspaces",
    });
    expect(sections[0]!.items.filter((i) => i.current).map((i) => i.label)).toEqual([
      "Screenshots",
    ]);
  });

  it("nests the settings sub-pages under settings only on settings routes", () => {
    const plain = accountNavSections({
      pathname: "/account/workspaces/acme/people",
      workspace: "acme",
      section: "workspaces",
    });
    expect(plain[0]!.items.some((i) => i.nested)).toBe(false);

    const settings = accountNavSections({
      pathname: "/account/workspaces/acme/settings/storage",
      workspace: "acme",
      section: "workspaces",
    });
    const nested = settings[0]!.items.filter((i) => i.nested);
    expect(nested.map((i) => i.label)).toEqual(["GitHub comment", "Storage"]);
    expect(nested.map((i) => i.current)).toEqual([false, true]);
    expect(nested[1]!.href).toBe("/account/workspaces/acme/settings/storage");
  });

  it("marks the comment sub-page current on the settings root", () => {
    const sections = accountNavSections({
      pathname: "/account/workspaces/acme/settings",
      workspace: "acme",
      section: "workspaces",
    });
    const nested = sections[0]!.items.filter((i) => i.nested);
    expect(nested.map((i) => i.current)).toEqual([true, false]);
  });

  it("encodes the workspace slug in hrefs", () => {
    const sections = accountNavSections({
      pathname: "/account/profile",
      workspace: "a b",
      section: "profile",
    });
    expect(sections[0]!.items[0]!.href).toBe("/account/workspaces/a%20b/screenshots");
  });

  it("marks no workspace tab current on a personal route", () => {
    const sections = accountNavSections({
      pathname: "/account/profile",
      workspace: "acme",
      section: "profile",
    });
    expect(sections[0]!.items.some((i) => i.current)).toBe(false);
  });
});

describe("adminNavSections", () => {
  it("marks the active admin section", () => {
    const sections = adminNavSections({ section: "metrics" });
    expect(sections.map((s) => s.label)).toEqual(["Admin", "Personal"]);
    const items = sections[0]!.items;
    expect(items.map((i) => i.href)).toEqual([
      "/admin",
      "/admin/metrics",
      "/admin/users",
      "/admin/oauth",
      "/admin/email",
    ]);
    expect(items.filter((i) => i.current).map((i) => i.label)).toEqual(["Metrics"]);
  });

  it("keeps the Personal group to the account link", () => {
    expect(adminNavSections({ section: "workspaces" })[1]!.items.map((i) => i.label)).toEqual([
      "Account",
    ]);
  });
});

describe("workspaceSwitcherData", () => {
  it("labels the active workspace by organization name, falling back to the slug", () => {
    expect(workspaceSwitcherData(sample, { active: "side" }).activeLabel).toBe("Side Project");
    expect(workspaceSwitcherData(sample, { active: "buildinternet" }).activeLabel).toBe(
      "buildinternet",
    );
    expect(workspaceSwitcherData(sample, { active: "unknown" }).activeLabel).toBe("unknown");
    expect(workspaceSwitcherData(sample).activeLabel).toBe("workspaces");
  });

  it("marks the current option and preserves the active tab in row hrefs", () => {
    const data = workspaceSwitcherData(sample, { active: "buildinternet", activeTab: "settings" });
    expect(data.options.map((o) => o.href)).toEqual([
      "/account/workspaces/buildinternet/settings",
      "/account/workspaces/side/settings",
    ]);
    expect(data.options.map((o) => o.current)).toEqual([true, false]);
  });

  it("falls back to screenshots with no active tab", () => {
    expect(workspaceSwitcherData(sample)!.options[0]!.href).toBe(
      "/account/workspaces/buildinternet/screenshots",
    );
  });

  it("flags Pro on the trigger and the matching row only", () => {
    const withPlans = [ws("buildinternet", "", "pro"), ws("side", "Side Project", "free")];
    const data = workspaceSwitcherData(withPlans, { active: "buildinternet" });
    expect(data.activePro).toBe(true);
    expect(data.options.map((o) => o.pro)).toEqual([true, false]);
    expect(workspaceSwitcherData(withPlans, { active: "side" }).activePro).toBe(false);
    expect(workspaceSwitcherData(withPlans).activePro).toBe(false);
  });

  it("offers create while allowed and manage at the cap", () => {
    expect(workspaceSwitcherData(sample).createHref).toBe("/account/workspaces/new");
    expect(
      workspaceSwitcherData(sample, { quota: { allowed: true, cap: 3, used: 1 } }).createHref,
    ).toBe("/account/workspaces/new");
    const capped = workspaceSwitcherData(sample, {
      quota: { allowed: false, cap: 3, used: 3 },
    });
    expect(capped.createHref).toBeNull();
    expect(capped.manageHref).toBe("/account/workspaces?manage=1");
  });

  it("shapes an empty membership list", () => {
    const data = workspaceSwitcherData([], { active: "acme" });
    expect(data.options).toEqual([]);
    expect(data.activeLabel).toBe("acme");
  });
});
