import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveScreenshotDefaults } from "../src/config-file.js";

describe("resolveScreenshotDefaults", () => {
  const prev = process.env.UPLOADS_SCREENSHOT_VIA;
  const prevBic = process.env.BUILDINTERNET_CONFIG;
  afterEach(() => {
    if (prev === undefined) delete process.env.UPLOADS_SCREENSHOT_VIA;
    else process.env.UPLOADS_SCREENSHOT_VIA = prev;
    if (prevBic === undefined) delete process.env.BUILDINTERNET_CONFIG;
    else process.env.BUILDINTERNET_CONFIG = prevBic;
  });

  it("is undefined by default (caller falls back to auto)", () => {
    delete process.env.UPLOADS_SCREENSHOT_VIA;
    process.env.BUILDINTERNET_CONFIG = "/nonexistent/uploads-config";
    expect(resolveScreenshotDefaults({}).via).toBeUndefined();
  });

  it("reads a valid value from env", () => {
    process.env.UPLOADS_SCREENSHOT_VIA = "local";
    process.env.BUILDINTERNET_CONFIG = "/nonexistent/uploads-config";
    expect(resolveScreenshotDefaults({}).via).toBe("local");
  });

  it("ignores an invalid value from env", () => {
    process.env.UPLOADS_SCREENSHOT_VIA = "carrier-pigeon";
    process.env.BUILDINTERNET_CONFIG = "/nonexistent/uploads-config";
    expect(resolveScreenshotDefaults({}).via).toBeUndefined();
  });

  it("env wins over --env-file, which wins over the user config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "uploads-screenshot-config-"));
    const userConfig = join(dir, "user-config");
    const envFile = join(dir, "env-file");
    writeFileSync(userConfig, "UPLOADS_SCREENSHOT_VIA=remote\n");
    writeFileSync(envFile, "UPLOADS_SCREENSHOT_VIA=local\n");
    process.env.BUILDINTERNET_CONFIG = userConfig;

    delete process.env.UPLOADS_SCREENSHOT_VIA;
    expect(resolveScreenshotDefaults({}).via).toBe("remote");
    expect(resolveScreenshotDefaults({ envFile }).via).toBe("local");

    process.env.UPLOADS_SCREENSHOT_VIA = "auto";
    expect(resolveScreenshotDefaults({ envFile }).via).toBe("auto");
  });
});
