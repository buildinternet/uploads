import { describe, expect, it } from "vitest";
import { mcpResourceAndOrigin, oauthResources } from "./auth";

describe("mcpResourceAndOrigin", () => {
  it("adds the origin form next to a /mcp identifier", () => {
    expect(mcpResourceAndOrigin("https://agents.uploads.sh/mcp")).toEqual([
      "https://agents.uploads.sh/mcp",
      "https://agents.uploads.sh",
    ]);
  });

  it("treats a trailing slash on /mcp the same as /mcp", () => {
    expect(mcpResourceAndOrigin("https://mcp.uploads.sh/mcp/")).toEqual([
      "https://mcp.uploads.sh/mcp/",
      "https://mcp.uploads.sh",
    ]);
  });

  it("leaves an already origin-shaped identifier unchanged", () => {
    expect(mcpResourceAndOrigin("https://agents.uploads.sh")).toEqual([
      "https://agents.uploads.sh",
    ]);
  });

  it("passes through a non-URL value", () => {
    expect(mcpResourceAndOrigin("not-a-url")).toEqual(["not-a-url"]);
  });
});

describe("oauthResources", () => {
  it("lists /mcp and origin for every hosted MCP identifier", () => {
    expect(oauthResources()).toEqual([
      "https://agents.uploads.sh/mcp",
      "https://agents.uploads.sh",
      "https://mcp.uploads.sh/mcp",
      "https://mcp.uploads.sh",
    ]);
  });
});
