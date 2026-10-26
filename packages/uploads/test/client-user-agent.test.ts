import { afterEach, describe, expect, it, vi } from "vitest";
import { createUploadsClient } from "../src/client.js";
import { packageVersion } from "../src/package-version.js";

afterEach(() => vi.unstubAllGlobals());

async function userAgentFor(surface?: "cli" | "mcp"): Promise<string | null> {
  let seen: Headers | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response(JSON.stringify({ files: [], truncated: false }), { status: 200 });
    }),
  );
  const client = createUploadsClient(
    { apiUrl: "https://api.test", workspace: "test", token: "up_test_x" },
    surface ? { surface } : undefined,
  );
  await client.list();
  return seen?.get("User-Agent") ?? null;
}

describe("client User-Agent", () => {
  it("names the package version and the cli surface by default", async () => {
    expect(await userAgentFor()).toBe(`@buildinternet/uploads/${packageVersion()} (cli)`);
  });

  it("marks the stdio MCP server's requests", async () => {
    expect(await userAgentFor("mcp")).toBe(`@buildinternet/uploads/${packageVersion()} (mcp)`);
  });
});
