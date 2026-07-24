/**
 * `uploads config init` with no flags used to seed `UPLOADS_WORKSPACE=default`
 * into the config file. That entry outranks the workspace encoded in the token
 * itself (see `resolveConfig`'s precedence: flag → env → env-file → config file
 * → token), so it pinned every later login to `default` regardless of which
 * workspace the user's token was actually minted for. Seeding the API URL has
 * no such conflict — there is no "API URL embedded in the token" concept.
 */
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfig } from "../src/commands/config.js";
import { loadConfigFile } from "../src/config-file.js";

afterEach(() => vi.restoreAllMocks());

function silence() {
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
}

function freshPath() {
  return join(mkdtempSync(join(tmpdir(), "uploads-config-init-")), "config");
}

describe("uploads config init", () => {
  it("seeds the API URL but never a workspace when no flags are passed", async () => {
    const path = freshPath();
    silence();
    expect(await runConfig(["init", "--path", path], {})).toBe(0);
    const written = loadConfigFile(path);
    expect(written.UPLOADS_API_URL).toBe("https://api.uploads.sh");
    expect(written.UPLOADS_WORKSPACE).toBeUndefined();
  });

  it("still writes a workspace when one is passed explicitly", async () => {
    const path = freshPath();
    silence();
    expect(await runConfig(["init", "--workspace", "acme", "--path", path], {})).toBe(0);
    expect(loadConfigFile(path).UPLOADS_WORKSPACE).toBe("acme");
  });

  it("leaves the token's own workspace free to win after a bare init", async () => {
    const path = freshPath();
    silence();
    await runConfig(["init", "--path", path], {});
    // No config-file workspace means `resolveConfig` falls through to the
    // workspace encoded in the token (`up_<workspace>_…`) rather than being
    // overridden by a seeded value.
    expect(loadConfigFile(path).UPLOADS_WORKSPACE).toBeUndefined();
    expect(existsSync(path)).toBe(true);
  });
});
