import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgv } from "../src/cli-args.js";
import { runCli } from "../src/cli.js";
import { packageVersion } from "../src/package-version.js";

describe("parseArgv --version", () => {
  it("accepts --version and -V as globals", () => {
    expect(parseArgv(["node", "uploads", "--version"]).globals.version).toBe(true);
    expect(parseArgv(["node", "uploads", "-V"]).globals.version).toBe(true);
    expect(parseArgv(["node", "uploads", "--json", "--version"]).globals).toMatchObject({
      json: true,
      version: true,
    });
  });
});

describe("runCli --version", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the package version on stdout and exits 0", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const code = await runCli(["node", "uploads", "--version"]);
    expect(code).toBe(0);
    expect(stdout.join("").trim()).toBe(packageVersion());
    expect(stderr.join("")).toBe("");
  });
});

describe("runCli usage errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("points at layered --help instead of dumping the root manual", async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    // Invalid install target throws UsageError without needing credentials.
    const code = await runCli(["node", "uploads", "install", "not-a-target"]);
    expect(code).toBe(2);
    const text = stderr.join("");
    expect(text).toMatch(/unknown install target/);
    expect(text).toMatch(/hint: uploads install --help/);
    expect(text).not.toMatch(/Agent\/MCP:/);
    expect(text).not.toMatch(/UPLOADS_DEFAULT_PREFIX/);
  });
});
