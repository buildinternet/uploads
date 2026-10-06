import { describe, expect, it } from "vitest";
import type { AdminWorkspaceSummary } from "./admin-api";
import { sortWorkspaces } from "./admin-workspace-sort";

function ws(
  workspace: string,
  overrides: Partial<AdminWorkspaceSummary> = {},
): AdminWorkspaceSummary {
  return {
    workspace,
    organization: null,
    memberCount: 1,
    pendingInviteCount: 0,
    plan: "free",
    byob: false,
    createdAt: null,
    ...overrides,
  } as AdminWorkspaceSummary;
}

const rows = [
  ws("beta", { createdAt: "2026-09-02T00:00:00.000Z", memberCount: 3 }),
  ws("acme", { createdAt: "2026-09-10T00:00:00.000Z", plan: "pro", byob: true }),
  ws("legacy"),
  ws("delta", { createdAt: "2026-08-01T00:00:00.000Z", memberCount: 3 }),
];

const names = (list: AdminWorkspaceSummary[]) => list.map((row) => row.workspace);

describe("sortWorkspaces", () => {
  it("sorts newest first and sinks undated workspaces", () => {
    expect(names(sortWorkspaces(rows, "created", "desc"))).toEqual([
      "acme",
      "beta",
      "delta",
      "legacy",
    ]);
  });

  it("sorts names alphabetically in either direction", () => {
    expect(names(sortWorkspaces(rows, "workspace", "asc"))).toEqual([
      "acme",
      "beta",
      "delta",
      "legacy",
    ]);
    expect(names(sortWorkspaces(rows, "workspace", "desc"))).toEqual([
      "legacy",
      "delta",
      "beta",
      "acme",
    ]);
  });

  it("breaks ties by name A→Z regardless of direction", () => {
    expect(names(sortWorkspaces(rows, "members", "desc"))).toEqual([
      "beta",
      "delta",
      "acme",
      "legacy",
    ]);
  });

  it("puts paid and BYO workspaces first when sorted descending", () => {
    expect(names(sortWorkspaces(rows, "plan", "desc"))[0]).toBe("acme");
    expect(names(sortWorkspaces(rows, "storage", "desc"))[0]).toBe("acme");
  });

  it("does not mutate the input", () => {
    const before = names(rows);
    sortWorkspaces(rows, "created", "asc");
    expect(names(rows)).toEqual(before);
  });
});
