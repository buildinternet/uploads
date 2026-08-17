import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildWhoamiReport, runLogout, runWhoami } from "../src/commands/session.js";
import { loadConfigFile, removeConfigKeys, writeConfigKeys } from "../src/config-file.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.UPLOADS_TOKEN;
  delete process.env.UPLOADS_WORKSPACE;
  delete process.env.UPLOADS_API_URL;
});

function capture() {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((v: string | Uint8Array) => {
    out += String(v);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((v: string | Uint8Array) => {
    err += String(v);
    return true;
  }) as typeof process.stderr.write);
  return { out: () => out, err: () => err };
}

describe("removeConfigKeys", () => {
  it("removes UPLOADS_TOKEN and preserves other keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "uploads-logout-"));
    const path = join(dir, "config");
    writeConfigKeys(path, {
      UPLOADS_API_URL: "https://api.uploads.sh",
      UPLOADS_WORKSPACE: "acme",
      UPLOADS_TOKEN: "up_acme_secrettokenvalue",
    });
    const result = removeConfigKeys(path, ["UPLOADS_TOKEN"]);
    expect(result.removed).toEqual(["UPLOADS_TOKEN"]);
    const raw = loadConfigFile(path);
    expect(raw.UPLOADS_TOKEN).toBeUndefined();
    expect(raw.UPLOADS_WORKSPACE).toBe("acme");
    expect(raw.UPLOADS_API_URL).toBe("https://api.uploads.sh");
  });

  it("is a no-op when the file is missing", () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-logout-")), "missing");
    expect(removeConfigKeys(path, ["UPLOADS_TOKEN"])).toEqual({
      path,
      removed: [],
      existed: false,
    });
  });
});

describe("buildWhoamiReport / runWhoami", () => {
  it("reports signed out when no token", () => {
    const dir = mkdtempSync(join(tmpdir(), "uploads-whoami-"));
    const path = join(dir, "config");
    writeFileSync(path, "UPLOADS_WORKSPACE=acme\n");
    const report = buildWhoamiReport({ envFile: path });
    expect(report.signedIn).toBe(false);
    expect(report.workspace).toBe("acme");
  });

  it("reports signed in with redacted token", () => {
    const dir = mkdtempSync(join(tmpdir(), "uploads-whoami-"));
    const path = join(dir, "config");
    writeConfigKeys(path, {
      UPLOADS_TOKEN: "up_acme_secrettokenvalue",
      UPLOADS_WORKSPACE: "acme",
    });
    const report = buildWhoamiReport({ envFile: path });
    expect(report.signedIn).toBe(true);
    expect(report.workspace).toBe("acme");
    expect(report.token).toMatch(/set \(/);
    expect(report.token).not.toContain("secrettokenvalue");
    expect(report.tokenInConfig).toBe(true);
    // --path is resolved as env-file layer
    expect(report.tokenSource).toBe("env-file");
  });

  it("exits 1 when signed out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uploads-whoami-"));
    const path = join(dir, "empty");
    writeFileSync(path, "");
    const io = capture();
    const code = await runWhoami([], { envFile: path });
    expect(code).toBe(1);
    expect(io.out()).toMatch(/signed in:\s+no/);
    expect(io.out()).toMatch(/uploads login/);
  });

  it("exits 0 and prints whoami when signed in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uploads-whoami-"));
    const path = join(dir, "config");
    writeConfigKeys(path, { UPLOADS_TOKEN: "up_acme_secrettokenvalue" });
    const io = capture();
    const code = await runWhoami([], { envFile: path });
    expect(code).toBe(0);
    expect(io.out()).toMatch(/signed in:\s+yes/);
    expect(io.out()).toMatch(/workspace:/);
  });

  it("prints help", async () => {
    const io = capture();
    expect(await runWhoami([], {}, true)).toBe(0);
    expect(io.err()).toMatch(/uploads whoami/);
  });
});

describe("runLogout", () => {
  it("removes the token from the config file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uploads-logout-"));
    const path = join(dir, "config");
    writeConfigKeys(path, {
      UPLOADS_TOKEN: "up_acme_secrettokenvalue",
      UPLOADS_WORKSPACE: "acme",
    });
    const io = capture();
    const code = await runLogout(["--path", path], {});
    expect(code).toBe(0);
    expect(io.out()).toMatch(/signed out/);
    expect(loadConfigFile(path).UPLOADS_TOKEN).toBeUndefined();
    expect(loadConfigFile(path).UPLOADS_WORKSPACE).toBe("acme");
    // file still exists and is not empty of other keys
    expect(readFileSync(path, "utf8")).toMatch(/UPLOADS_WORKSPACE/);
  });

  it("notes when env token remains", async () => {
    process.env.UPLOADS_TOKEN = "up_env_only_token_value";
    const dir = mkdtempSync(join(tmpdir(), "uploads-logout-"));
    const path = join(dir, "config");
    writeFileSync(path, "UPLOADS_WORKSPACE=acme\n");
    const io = capture();
    await runLogout(["--path", path], {});
    expect(io.err()).toMatch(/environment/);
  });

  it("prints help", async () => {
    const io = capture();
    expect(await runLogout([], {}, true)).toBe(0);
    expect(io.err()).toMatch(/uploads logout/);
  });
});
