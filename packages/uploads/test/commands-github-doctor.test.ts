import { describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import { UploadsError } from "../src/errors.js";
import type { GithubHealthResult, UploadsClient } from "../src/client.js";
import { runGithub, type CliContext } from "../src/commands.js";

function ctxWith(client: UploadsClient, json = false): CliContext {
  return {
    config: {
      apiUrl: "https://x.test",
      workspace: "acme",
      token: "up_acme_x",
      workspaceSource: "override",
      configPath: "/tmp/uploads-test-config",
      configExists: false,
    },
    client,
    json,
    quiet: true,
  };
}

function clientWith(result: GithubHealthResult): UploadsClient {
  return { githubHealth: async () => result } as unknown as UploadsClient;
}

describe("runGithub (doctor)", () => {
  it("exits 0 and prints ok when subscribed to all required events", async () => {
    const stdout: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => (stdout.push(String(chunk)), true));
    try {
      const code = await runGithub(
        ctxWith(
          clientWith({
            configured: true,
            ok: true,
            events: ["ping", "issues", "pull_request"],
            missingEvents: [],
            requiredEvents: ["issues", "pull_request"],
          }),
        ),
        ["doctor"],
      );
      expect(code).toBe(0);
      expect(stdout.join("")).toContain("ok");
    } finally {
      spy.mockRestore();
    }
  });

  it("exits 1 and reports missing events", async () => {
    const stdout: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => (stdout.push(String(chunk)), true));
    try {
      const code = await runGithub(
        ctxWith(
          clientWith({
            configured: true,
            ok: false,
            events: ["ping"],
            missingEvents: ["issues", "pull_request"],
            requiredEvents: ["issues", "pull_request"],
            hint: "subscribe to issues, pull_request at github.com/settings/apps/…",
          }),
        ),
        ["doctor"],
      );
      expect(code).toBe(1);
      expect(stdout.join("")).toContain("issues, pull_request");
    } finally {
      spy.mockRestore();
    }
  });

  it("exits 1 when the App isn't configured", async () => {
    const code = await runGithub(
      ctxWith(
        clientWith({
          configured: false,
          ok: false,
          events: null,
          missingEvents: ["issues", "pull_request"],
          requiredEvents: ["issues", "pull_request"],
        }),
      ),
      ["doctor", "--json"],
      false,
    );
    expect(code).toBe(1);
  });

  it("emits JSON with --json", async () => {
    let written: unknown;
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written = JSON.parse(String(chunk));
      return true;
    });
    try {
      const ctx = ctxWith(
        clientWith({
          configured: true,
          ok: true,
          events: ["issues", "pull_request"],
          missingEvents: [],
          requiredEvents: ["issues", "pull_request"],
        }),
        true,
      );
      const code = await runGithub(ctx, ["doctor"]);
      expect(code).toBe(0);
      expect(written).toMatchObject({ ok: true });
    } finally {
      spy.mockRestore();
    }
  });

  it("degrades clearly on a 404 (older server without the health route)", async () => {
    const client = {
      githubHealth: async () => {
        throw new UploadsError("not found", "NOT_FOUND", 404);
      },
    } as unknown as UploadsClient;
    await expect(runGithub(ctxWith(client), ["doctor"])).rejects.toThrow(UsageError);
  });

  it("exits 0 but prints a note line when only a recommended event is missing", async () => {
    const stdout: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => (stdout.push(String(chunk)), true));
    try {
      const code = await runGithub(
        ctxWith(
          clientWith({
            configured: true,
            ok: true,
            events: ["ping", "issues", "pull_request"],
            missingEvents: [],
            requiredEvents: ["issues", "pull_request"],
            recommendedEvents: ["issue_comment"],
            missingRecommendedEvents: ["issue_comment"],
          }),
        ),
        ["doctor"],
      );
      expect(code).toBe(0);
      const out = stdout.join("");
      expect(out).toContain("ok");
      expect(out).toContain("note: not subscribed to issue_comment (recommended)");
    } finally {
      spy.mockRestore();
    }
  });

  it("tolerates an older server payload without recommended fields (no crash, no note line)", async () => {
    const stdout: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => (stdout.push(String(chunk)), true));
    try {
      const code = await runGithub(
        ctxWith(
          clientWith({
            configured: true,
            ok: true,
            events: ["ping", "issues", "pull_request"],
            missingEvents: [],
            requiredEvents: ["issues", "pull_request"],
            // recommendedEvents/missingRecommendedEvents intentionally omitted
          }),
        ),
        ["doctor"],
      );
      expect(code).toBe(0);
      const out = stdout.join("");
      expect(out).toContain("ok");
      expect(out).not.toContain("note:");
    } finally {
      spy.mockRestore();
    }
  });
});
