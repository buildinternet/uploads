import { describe, expect, it } from "vitest";
import { workspaceFromAdminSearch } from "./admin-workspace-link";

describe("workspaceFromAdminSearch", () => {
  it("reads a workspace slug from the admin query", () => {
    expect(workspaceFromAdminSearch("?workspace=acme")).toBe("acme");
    expect(workspaceFromAdminSearch("?other=1&workspace=acme")).toBe("acme");
  });

  it("returns null when the query is missing or blank", () => {
    expect(workspaceFromAdminSearch("")).toBeNull();
    expect(workspaceFromAdminSearch("?workspace=")).toBeNull();
    expect(workspaceFromAdminSearch("?workspace=%20")).toBeNull();
  });
});
