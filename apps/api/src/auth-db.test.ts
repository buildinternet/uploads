import { describe, expect, it } from "vitest";
import {
  isWorkspaceScope,
  parseScopes,
  validateScopes,
  WORKSPACE_SCOPES,
  type FileScope,
} from "./auth-db";

const DEFAULTS: FileScope[] = ["files:read", "files:write"];

describe("isWorkspaceScope (#262)", () => {
  it("recognizes workspace:invite and workspace:manage", () => {
    for (const scope of WORKSPACE_SCOPES) {
      expect(isWorkspaceScope(scope)).toBe(true);
    }
  });

  it("rejects unrelated strings", () => {
    expect(isWorkspaceScope("files:read")).toBe(false);
    expect(isWorkspaceScope("operator:read")).toBe(false);
    expect(isWorkspaceScope("workspace:nuke")).toBe(false);
  });
});

describe("validateScopes allowWorkspace gating (#262)", () => {
  it("rejects workspace:* scopes when allowWorkspace is omitted (existing callers unchanged)", () => {
    expect(validateScopes(["workspace:invite"], DEFAULTS)).toBeNull();
  });

  it("rejects workspace:* scopes when allowWorkspace is false", () => {
    expect(validateScopes(["workspace:invite"], DEFAULTS, { allowWorkspace: false })).toBeNull();
  });

  it("accepts workspace:* scopes when allowWorkspace is true", () => {
    expect(
      validateScopes(["files:read", "workspace:invite"], DEFAULTS, { allowWorkspace: true }),
    ).toEqual(["files:read", "workspace:invite"]);
  });

  it("requires both gates for a mixed operator:* + workspace:* request", () => {
    // Only allowOperator set -> workspace:* still rejected.
    expect(
      validateScopes(["operator:read", "workspace:invite"], DEFAULTS, { allowOperator: true }),
    ).toBeNull();
    // Only allowWorkspace set -> operator:* still rejected.
    expect(
      validateScopes(["operator:read", "workspace:invite"], DEFAULTS, { allowWorkspace: true }),
    ).toBeNull();
    // Both set -> accepted.
    expect(
      validateScopes(["operator:read", "workspace:invite"], DEFAULTS, {
        allowOperator: true,
        allowWorkspace: true,
      }),
    ).toEqual(["operator:read", "workspace:invite"]);
  });
});

describe("parseScopes fail-closed for governance scopes (#262)", () => {
  it("rejects an array containing a workspace:* scope — a governance token has zero file access", () => {
    expect(parseScopes(JSON.stringify(["workspace:invite"]))).toEqual([]);
  });

  it("rejects a mixed file + workspace:* array (no partial file access)", () => {
    expect(parseScopes(JSON.stringify(["files:read", "workspace:invite"]))).toEqual([]);
  });

  it("still parses plain file scopes", () => {
    expect(parseScopes(JSON.stringify(["files:read"]))).toEqual(["files:read"]);
  });
});
