import { describe, expect, it } from "vitest";
import type { AdminClientActivity } from "./admin-api";
import {
  clientLabel,
  clientOwnerLabel,
  clientVersionStatus,
  summarizeClients,
  surfaceLabel,
} from "./admin-clients";

function row(overrides: Partial<AdminClientActivity> = {}): AdminClientActivity {
  return {
    workspace: "acme",
    principal: "token:tok-1",
    surface: "cli",
    email: "ada@example.com",
    tokenLabel: "laptop",
    serviceToken: false,
    clientName: "@buildinternet/uploads",
    clientVersion: "1.2.0",
    lastSeenAt: "2026-10-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("clientVersionStatus", () => {
  it("flags CLI and local-MCP rows behind the published version", () => {
    expect(clientVersionStatus(row(), "1.3.0")).toBe("outdated");
    expect(clientVersionStatus(row({ surface: "mcp-local" }), "1.3.0")).toBe("outdated");
    expect(clientVersionStatus(row(), "1.2.0")).toBe("current");
    expect(clientVersionStatus(row({ clientVersion: "1.4.0" }), "1.3.0")).toBe("current");
  });

  it("is unknown for hosted MCP, a missing latest, or an unparseable version", () => {
    expect(clientVersionStatus(row({ surface: "mcp-remote", clientVersion: "0.1" }), "1.3.0")).toBe(
      "unknown",
    );
    expect(clientVersionStatus(row(), null)).toBe("unknown");
    expect(clientVersionStatus(row({ clientVersion: "dev" }), "1.3.0")).toBe("unknown");
    expect(clientVersionStatus(row({ clientVersion: null }), "1.3.0")).toBe("unknown");
  });
});

describe("labels", () => {
  it("names the owner by email, service-token label, then principal", () => {
    expect(clientOwnerLabel(row())).toBe("ada@example.com");
    expect(clientOwnerLabel(row({ serviceToken: true, tokenLabel: "ci-bot" }))).toBe("ci-bot");
    expect(clientOwnerLabel(row({ email: null, tokenLabel: null }))).toBe("token:tok-1");
    expect(
      clientOwnerLabel(row({ email: null, tokenLabel: null, principal: "legacy:b87f5ba8" })),
    ).toBe("legacy token b87f5ba8");
  });

  it("names the client and surface", () => {
    expect(clientLabel(row())).toBe("uploads");
    expect(clientLabel(row({ surface: "mcp-remote", clientName: "claude-code" }))).toBe(
      "claude-code",
    );
    expect(surfaceLabel("mcp-remote")).toBe("Hosted MCP");
    expect(surfaceLabel("other")).toBe("other");
  });
});

describe("summarizeClients", () => {
  it("counts only rows with a known status", () => {
    const rows = [
      row(),
      row({ clientVersion: "1.3.0" }),
      row({ surface: "mcp-remote", clientName: "claude-code", clientVersion: "2.0.0" }),
    ];
    expect(summarizeClients(rows, "1.3.0")).toEqual({ tracked: 2, outdated: 1 });
  });
});
