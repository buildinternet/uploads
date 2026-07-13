import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outputFormat, runCli } from "../src/cli.js";

describe("outputFormat", () => {
  it("global --json wins over --format", () => {
    expect(outputFormat(["n", "u", "put", "x", "--format", "url", "--json"])).toBe("json");
  });
  it("detects a --format json value", () => {
    expect(outputFormat(["n", "u", "put", "x", "--format", "json"])).toBe("json");
  });
  it("detects --format=url", () => {
    expect(outputFormat(["n", "u", "put", "x", "--format=url"])).toBe("url");
  });
  it("defaults to human", () => {
    expect(outputFormat(["n", "u", "put", "x"])).toBe("human");
  });
});

describe("runCli surfaces failures on stdout for scripted output", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes a structured JSON error to stdout under --json", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // `--token` with no value throws a UsageError through the top-level catch.
    const code = await runCli(["node", "uploads", "--json", "--token"]);

    expect(code).toBe(2);
    const parsed = JSON.parse(out.join("")) as { error: string; code: string };
    expect(parsed.error).toMatch(/missing value for --token/);
    expect(parsed.code).toBe("USAGE");
  });
});

describe("missing token is an onboarding nudge, not an error: framing", () => {
  beforeEach(() => {
    vi.stubEnv("BUILDINTERNET_CONFIG", "/nonexistent/uploads-missing-token-test-config");
    vi.stubEnv("UPLOADS_TOKEN", "");
    vi.stubEnv("UPLOADS_WORKSPACE", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("human put without a token has no 'error:' prefix and leads with login", async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });

    const code = await runCli(["node", "uploads", "put", "/tmp/does-not-need-to-exist.png"]);
    expect(code).toBe(2);
    const printed = err.join("");
    expect(printed).toMatch(/not signed in yet/i);
    expect(printed).toMatch(/uploads login/);
    expect(printed).not.toMatch(/^error:/m);
    expect(printed).not.toMatch(/\nerror:/);
  });

  it("--format url without a token writes a short non-error nudge to stdout", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await runCli(["node", "uploads", "put", "/tmp/x.png", "--format", "url"]);
    expect(code).toBe(2);
    const printed = out.join("");
    expect(printed).toMatch(/not signed in/i);
    expect(printed).toMatch(/uploads login/);
    expect(printed).not.toMatch(/^error:/m);
  });

  it("--json still exposes MISSING_TOKEN for agents", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await runCli(["node", "uploads", "--json", "put", "/tmp/x.png"]);
    expect(code).toBe(2);
    const parsed = JSON.parse(out.join("")) as { error: string; code: string };
    expect(parsed.code).toBe("MISSING_TOKEN");
    expect(parsed.error).toMatch(/uploads login/);
  });
});
