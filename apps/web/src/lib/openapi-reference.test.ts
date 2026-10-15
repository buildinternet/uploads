import { describe, expect, it } from "vitest";
import spec from "../../public/.well-known/openapi.json";
import { buildApiReference } from "./openapi-reference";

const groups = buildApiReference(spec as Record<string, unknown>);
const operations = groups.flatMap((group) => group.operations);
const find = (method: string, path: string) =>
  operations.find((op) => op.method === method && op.path === path);

describe("buildApiReference", () => {
  it("lists every operation in the spec exactly once", () => {
    const expected = Object.values(spec.paths).reduce(
      (count, item) =>
        count + ["get", "post", "put", "patch", "delete"].filter((method) => method in item).length,
      0,
    );
    expect(operations).toHaveLength(expected);
    expect(new Set(operations.map((op) => op.id)).size).toBe(expected);
  });

  it("files every operation under a named section", () => {
    expect(groups.map((group) => group.id)).not.toContain("other");
  });

  it("merges path-level parameters and resolves refs", () => {
    const put = find("PUT", "/v1/workspaces/{workspace}/files/{key}");
    expect(put?.scopes).toEqual(["files:write"]);
    expect(put?.bodyContentType).toBe("application/octet-stream");
    expect(put?.params.map((p) => `${p.location}:${p.name}`)).toEqual([
      "path:workspace",
      "path:key",
      "query:replace",
      "query:dryRun",
      "header:Idempotency-Key",
    ]);
    expect(put?.responses.find((r) => r.status === "429")?.description).toMatch(/rate limit/);
    expect(put?.responses.find((r) => r.status === "201")?.fields).toContain("replaced");
  });

  it("lists JSON body fields as parameters", () => {
    const create = find("POST", "/v1/workspaces/{workspace}/galleries");
    const title = create?.params.find((p) => p.name === "title");
    expect(title).toMatchObject({ location: "body", type: "string", required: true });
  });

  it("marks unauthenticated routes public", () => {
    const feed = find("GET", "/public/feeds/{feedId}");
    expect(feed?.isPublic).toBe(true);
    expect(feed?.scopes).toEqual([]);
  });
});
