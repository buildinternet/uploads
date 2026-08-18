import { describe, expect, it, vi } from "vitest";
import type { UploadsClient } from "../src/client.js";
import type { UploadsClientConfig } from "../src/config.js";
import type { CommandRunner } from "../src/github-gh.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createUploadsMcpTools } from "../src/mcp/tools.js";
import { rpc, validator } from "./mcp-harness.js";

// The screenshot tool dynamically imports "../screenshot.js" from inside its
// handler (by design — keeps mcp/tools.ts free of a static reference to the
// local-backend chain). Mock captureScreenshot there so this test never
// launches a browser or hits the network, while keeping the real parsers.
// State-aware: mimics the real captureScreenshot's state-folding (issue
// #618) closely enough to assert the tool wires `state` through correctly,
// without going through the real backend-selection code.
vi.mock("../src/screenshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/screenshot.js")>();
  return {
    ...actual,
    captureScreenshot: vi.fn(async (opts: { state?: string }) => ({
      png: new Uint8Array([1, 2, 3]),
      filename: opts.state ? `example-com-${opts.state}.png` : "example-com.png",
      backend: "remote" as const,
    })),
  };
});

function fakeClient(puts: { key?: string; metadata?: Record<string, string> }[]): UploadsClient {
  return {
    put: async (
      body: Uint8Array,
      opts: { filename: string; key?: string; metadata?: Record<string, string> },
    ) => {
      puts.push({ key: opts.key, metadata: opts.metadata });
      return {
        workspace: "test",
        key: opts.key ?? "screenshots/misc/generated.png",
        url: `https://x.test/${opts.key ?? "screenshots/misc/generated.png"}`,
        embedUrl: null,
        size: body.byteLength,
        contentType: "image/png",
        metadata: opts.metadata,
      };
    },
    list: async () => ({ items: [], cursor: null }),
    health: async () => ({ ok: true }),
  } as unknown as UploadsClient;
}

function serverWith(overrides?: { runner?: CommandRunner }) {
  const puts: { key?: string; metadata?: Record<string, string> }[] = [];
  const client = fakeClient(puts);
  const server = createMcpServer({
    serverInfo: { name: "uploads", version: "0.0.0-test" },
    validator,
    tools: createUploadsMcpTools({
      globals: { apiUrl: "https://x.test", token: "up_test_x" },
      runner: overrides?.runner,
      clientFactory: (_config: UploadsClientConfig) => client,
    }),
  });
  return { server, puts };
}

const noRun: CommandRunner = () => {
  throw new Error("runner should not be called");
};

/**
 * Fake gh/git runner for the auto branch-staging trigger (issue #469 lever
 * 1), mirroring `branchStagingRunner` in mcp.test.ts for the `put` tool
 * (issue #403).
 */
function branchStagingRunner(opts: {
  branch?: string;
  defaultBranch?: string;
  originUrl?: string;
  repo?: string;
}): CommandRunner {
  return (cmd, args) => {
    if (cmd === "git" && args[0] === "config") {
      if (opts.originUrl === undefined) throw new Error("not a git repo");
      return `${opts.originUrl}\n`;
    }
    if (cmd === "git" && args[0] === "rev-parse") {
      if (opts.branch === undefined) throw new Error("detached HEAD");
      return `${opts.branch}\n`;
    }
    if (cmd === "git" && args[0] === "symbolic-ref") {
      if (opts.defaultBranch === undefined) throw new Error("no origin/HEAD");
      return `origin/${opts.defaultBranch}\n`;
    }
    if (cmd === "gh" && args[0] === "repo") {
      if (opts.repo === undefined) throw new Error("gh unauthenticated");
      return `${opts.repo}\n`;
    }
    throw new Error(`unexpected: ${cmd} ${args.join(" ")}`);
  };
}

describe("mcp screenshot tool", () => {
  it("is listed in tools/list", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/list");
    // oxlint-disable-next-line no-explicit-any
    const tools = res.result.tools as Array<any>;
    expect(tools.some((t) => t.name === "screenshot")).toBe(true);
  });

  it("captures (mocked) and uploads, returning url + markdown", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: { target: "https://example.com" },
    });
    expect(res.result.isError).toBe(false);
    const content = res.result.structuredContent as {
      url: string;
      markdown: string;
      backend: string;
    };
    expect(content.backend).toBe("remote");
    expect(content.url).toContain("https://x.test/");
    expect(content.markdown).toContain("![");
  });

  it("rejects a missing target as a tool error", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", { name: "screenshot", arguments: {} });
    expect(res.result.isError).toBe(true);
  });

  it("rejects an invalid via value", async () => {
    const { server } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: { target: "https://example.com", via: "carrier-pigeon" },
    });
    expect(res.result.isError).toBe(true);
  });
});

describe("mcp screenshot tool --state folded into the derived name (issue #618)", () => {
  it("folds state into the derived key, so before/after produce distinct objects", async () => {
    const { server: serverBefore, puts: putsBefore } = serverWith();
    const beforeRes = await rpc(serverBefore, "tools/call", {
      name: "screenshot",
      arguments: { target: "https://example.com", state: "before", pr: 9, repo: "o/r" },
    });
    expect(beforeRes.result.isError).toBe(false);
    expect(putsBefore[0]?.key).toBe("gh/o/r/pull/9/example-com-before.png");

    const { server: serverAfter, puts: putsAfter } = serverWith();
    const afterRes = await rpc(serverAfter, "tools/call", {
      name: "screenshot",
      arguments: { target: "https://example.com", state: "after", pr: 9, repo: "o/r" },
    });
    expect(afterRes.result.isError).toBe(false);
    expect(putsAfter[0]?.key).toBe("gh/o/r/pull/9/example-com-after.png");
    expect(putsAfter[0]?.key).not.toBe(putsBefore[0]?.key);
  });

  it("does not fold state when an explicit key is given", async () => {
    const { server, puts } = serverWith();
    const res = await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: {
        target: "https://example.com",
        state: "before",
        key: "screenshots/explicit.png",
      },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0]?.key).toBe("screenshots/explicit.png");
  });
});

describe("mcp screenshot canonical metadata", () => {
  /** Like serverWith(), but exposes the captured put() options. */
  function serverCapturing() {
    const puts: { metadata?: Record<string, string> }[] = [];
    const client = {
      put: async (
        body: Uint8Array,
        opts: { filename: string; key?: string; metadata?: Record<string, string> },
      ) => {
        puts.push({ metadata: opts.metadata });
        return {
          workspace: "test",
          key: opts.key ?? "screenshots/misc/generated.png",
          url: `https://x.test/${opts.key ?? "screenshots/misc/generated.png"}`,
          embedUrl: null,
          size: body.byteLength,
          contentType: "image/png",
        };
      },
      list: async () => ({ items: [], cursor: null }),
      health: async () => ({ ok: true }),
    } as unknown as UploadsClient;
    const server = createMcpServer({
      serverInfo: { name: "uploads", version: "0.0.0-test" },
      validator,
      tools: createUploadsMcpTools({
        globals: { apiUrl: "https://x.test", token: "up_test_x" },
        clientFactory: (_config: UploadsClientConfig) => client,
      }),
    });
    return { server, puts };
  }

  // The shared metadata description promises uploads.sh derives these
  // "automatically where it can" — that must hold on MCP, not just the CLI.
  it("derives path, url and viewport like the CLI does", async () => {
    const { server, puts } = serverCapturing();
    await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: { target: "https://app.example/settings?tab=billing", noGit: true },
    });
    expect(puts[0]?.metadata?.path).toBe("/settings");
    expect(puts[0]?.metadata?.url).toBe("https://app.example/settings?tab=billing");
    expect(puts[0]?.metadata?.viewport).toBeDefined();
  });

  it("lets an explicit metadata key win over a derived one", async () => {
    const { server, puts } = serverCapturing();
    await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: {
        target: "https://app.example/settings",
        metadata: { path: "/custom" },
        noGit: true,
      },
    });
    expect(puts[0]?.metadata?.path).toBe("/custom");
  });

  it("stamps env=local for a localhost target", async () => {
    const { server, puts } = serverCapturing();
    await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: { target: "http://localhost:4321/docs", via: "local", noGit: true },
    });
    expect(puts[0]?.metadata?.env).toBe("local");
  });
});

describe("mcp screenshot tool auto branch staging (issue #469 lever 1)", () => {
  const staged = {
    branch: "feature/thing",
    defaultBranch: "main",
    originUrl: "git@github.com:o/r.git",
    repo: "o/r",
  };

  it("stages a bare screenshot (no pr/issue) on a non-default branch, same key as attach --branch", async () => {
    const { server, puts } = serverWith({ runner: branchStagingRunner(staged) });
    const res = await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: { target: "https://example.com" },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0]?.key).toBe("gh/o/r/branch/feature-thing/example-com.png");
  });

  it("carries derived + explicit metadata plus the branch gh.* pairs", async () => {
    const { server, puts } = serverWith({ runner: branchStagingRunner(staged) });
    const res = await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: {
        target: "https://example.com",
        metadata: { path: "/docs/limits" },
        state: "after",
      },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0]?.metadata).toMatchObject({
      "gh.repo": "o/r",
      "gh.kind": "branch",
      "gh.branch": "feature/thing",
      path: "/docs/limits",
      state: "after",
    });
  });

  it("does not auto-stage on the default branch", async () => {
    const { server, puts } = serverWith({
      runner: branchStagingRunner({ ...staged, branch: "main" }),
    });
    const res = await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: { target: "https://example.com" },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0]?.key).toBeUndefined();
  });

  it("does not auto-stage with noGit", async () => {
    const { server, puts } = serverWith({ runner: noRun });
    const res = await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: { target: "https://example.com", noGit: true },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0]?.key).toBeUndefined();
  });

  it("does not auto-stage with an explicit pr target", async () => {
    const { server, puts } = serverWith({ runner: branchStagingRunner(staged) });
    const res = await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: { target: "https://example.com", pr: 9, repo: "o/r" },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0]?.key).toBe("gh/o/r/pull/9/example-com.png");
  });

  it("does not auto-stage with an explicit key", async () => {
    const { server, puts } = serverWith({ runner: branchStagingRunner(staged) });
    const res = await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: { target: "https://example.com", key: "screenshots/explicit.png" },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0]?.key).toBe("screenshots/explicit.png");
  });

  it("does not auto-stage with an explicit prefix", async () => {
    const { server, puts } = serverWith({ runner: branchStagingRunner(staged) });
    const res = await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: { target: "https://example.com", prefix: "custom" },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0]?.key).toBeUndefined();
  });
});

/** branchStagingRunner + a `gh pr view <branch>` stub for the #700 auto-PR lookup. */
function autoPrRunner(opts: {
  branch?: string;
  defaultBranch?: string;
  originUrl?: string;
  repo?: string;
  pr?: number;
}): CommandRunner {
  return (cmd, args) => {
    if (cmd === "gh" && args[0] === "pr" && args[1] === "view") {
      if (opts.pr === undefined) throw new Error("no pull request found");
      return `${opts.pr}\n`;
    }
    return branchStagingRunner(opts)(cmd, args);
  };
}

describe("mcp screenshot tool auto-PR context (issue #700)", () => {
  const withPr = {
    branch: "feature/thing",
    defaultBranch: "main",
    originUrl: "git@github.com:o/r.git",
    repo: "o/r",
    pr: 1250,
  };

  it("behaves as if pr had been passed when the branch maps to exactly one open PR", async () => {
    const { server, puts } = serverWith({ runner: autoPrRunner(withPr) });
    const res = await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: { target: "https://example.com" },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0]?.key).toBe("gh/o/r/pull/1250/example-com.png");
    expect(res.result.structuredContent.hint).toContain("branch maps to open PR #1250");
  });

  it("opts out with noPr, falling back to auto branch staging", async () => {
    const { server, puts } = serverWith({ runner: autoPrRunner(withPr) });
    const res = await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: { target: "https://example.com", noPr: true },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0]?.key).toBe("gh/o/r/branch/feature-thing/example-com.png");
  });

  it("falls back to staging when there is no open PR for the branch", async () => {
    const { server, puts } = serverWith({ runner: autoPrRunner({ ...withPr, pr: undefined }) });
    const res = await rpc(server, "tools/call", {
      name: "screenshot",
      arguments: { target: "https://example.com" },
    });
    expect(res.result.isError).toBe(false);
    expect(puts[0]?.key).toBe("gh/o/r/branch/feature-thing/example-com.png");
  });
});
