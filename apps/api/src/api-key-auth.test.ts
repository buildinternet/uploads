import { describe, expect, it } from "vitest";
import { scopesFromApiKeyPermissions } from "./api-key-auth";

describe("scopesFromApiKeyPermissions", () => {
  it("defaults to read+write when permissions are omitted", () => {
    expect(scopesFromApiKeyPermissions(null)).toEqual(["files:read", "files:write"]);
    expect(scopesFromApiKeyPermissions(undefined)).toEqual(["files:read", "files:write"]);
  });

  it("maps files actions onto FILE_SCOPES", () => {
    expect(scopesFromApiKeyPermissions({ files: ["read", "write", "delete"] })).toEqual([
      "files:read",
      "files:write",
      "files:delete",
    ]);
    expect(scopesFromApiKeyPermissions({ files: ["read"] })).toEqual(["files:read"]);
  });

  it("returns no scopes for an empty or unknown permission set", () => {
    expect(scopesFromApiKeyPermissions({ files: [] })).toEqual([]);
    expect(scopesFromApiKeyPermissions({ projects: ["read"] })).toEqual([]);
    expect(scopesFromApiKeyPermissions("nope")).toEqual([]);
  });
});
