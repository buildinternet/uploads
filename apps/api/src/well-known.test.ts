import { describe, expect, it } from "vitest";
import { app } from "./index";

// The route reads only c.env.WEB_ORIGIN (with a fallback), no bindings.
const env = {} as unknown as Env;

describe("GET /.well-known/oauth-protected-resource", () => {
  it("advertises the API as an OAuth resource server (RFC 9728)", async () => {
    const response = await app.request(
      "https://api.uploads.sh/.well-known/oauth-protected-resource",
      { method: "GET" },
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toContain("max-age=300");

    const body = (await response.json()) as {
      resource: string;
      resource_name: string;
      scopes_supported: string[];
      bearer_methods_supported: string[];
      resource_documentation: string;
      authorization_servers?: unknown;
    };
    // resource is keyed to the request origin so preview URLs describe themselves.
    expect(body.resource).toBe("https://api.uploads.sh");
    expect(body.scopes_supported).toEqual(["files:read", "files:write", "files:delete"]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
    expect(body.resource_documentation).toBe("https://uploads.sh/auth.md");
    // apps/api's own call site deliberately doesn't pass `authorizationServers`
    // (see well-known.ts) — only apps/mcp does (issue #224). Not that the
    // field is unsupported; index.ts just never opts in.
    expect(body.authorization_servers).toBeUndefined();
  });
});
