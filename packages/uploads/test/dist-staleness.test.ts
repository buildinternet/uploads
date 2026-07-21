import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDistStaleness } from "../bin/dist-staleness.mjs";

describe("checkDistStaleness", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "uploads-staleness-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is a no-op when there is no src/ tree (published install)", () => {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "cli.js"), "export {}");

    const result = checkDistStaleness(root);
    expect(result.checked).toBe(false);
    expect(result.stale).toBe(false);
  });

  it("flags stale when dist/ is missing entirely", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "cli.ts"), "export {}");

    const result = checkDistStaleness(root);
    expect(result.checked).toBe(true);
    expect(result.stale).toBe(true);
  });

  it("flags stale when src/ was modified after dist/ was built", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    const distFile = join(root, "dist", "cli.js");
    const srcFile = join(root, "src", "cli.ts");
    writeFileSync(distFile, "export {}");
    writeFileSync(srcFile, "export {}");

    const old = new Date(Date.now() - 60_000);
    const fresh = new Date();
    utimesSync(distFile, old, old);
    utimesSync(srcFile, fresh, fresh);

    const result = checkDistStaleness(root);
    expect(result.checked).toBe(true);
    expect(result.stale).toBe(true);
  });

  it("is not stale when dist/ is newer than src/", () => {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    const distFile = join(root, "dist", "cli.js");
    const srcFile = join(root, "src", "cli.ts");
    writeFileSync(srcFile, "export {}");
    writeFileSync(distFile, "export {}");

    const old = new Date(Date.now() - 60_000);
    const fresh = new Date();
    utimesSync(srcFile, old, old);
    utimesSync(distFile, fresh, fresh);

    const result = checkDistStaleness(root);
    expect(result.checked).toBe(true);
    expect(result.stale).toBe(false);
  });
});
