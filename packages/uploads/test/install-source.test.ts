import { describe, expect, it } from "vitest";
import { detectInstallSource } from "../src/install-source.js";

describe("detectInstallSource", () => {
  it("classifies an npm global install", () => {
    const source = detectInstallSource(
      "/opt/homebrew/lib/node_modules/@buildinternet/uploads/dist/commands/update.js",
    );
    expect(source.kind).toBe("global");
    expect(source.manager).toBe("npm");
    expect(source.upgradeCommand).toEqual([
      "npm",
      "install",
      "-g",
      "@buildinternet/uploads@latest",
    ]);
  });

  it("classifies an nvm-managed npm global install", () => {
    const source = detectInstallSource(
      "/Users/dev/.nvm/versions/node/v24.3.0/lib/node_modules/@buildinternet/uploads/dist/cli.js",
    );
    expect(source.kind).toBe("global");
    expect(source.manager).toBe("npm");
  });

  it("classifies a pnpm global install", () => {
    const source = detectInstallSource(
      "/Users/dev/Library/pnpm/global/5/node_modules/@buildinternet/uploads/dist/cli.js",
    );
    expect(source.kind).toBe("global");
    expect(source.manager).toBe("pnpm");
    expect(source.upgradeCommand).toEqual(["pnpm", "add", "-g", "@buildinternet/uploads@latest"]);
  });

  it("classifies a bun global install", () => {
    const source = detectInstallSource(
      "/Users/dev/.bun/install/global/node_modules/@buildinternet/uploads/dist/cli.js",
    );
    expect(source.kind).toBe("global");
    expect(source.manager).toBe("bun");
    expect(source.upgradeCommand).toEqual(["bun", "add", "-g", "@buildinternet/uploads@latest"]);
  });

  it("classifies an npx cache entry", () => {
    const source = detectInstallSource(
      "/Users/dev/.npm/_npx/a1b2c3/node_modules/@buildinternet/uploads/dist/cli.js",
    );
    expect(source.kind).toBe("npx");
  });

  it("classifies a workspace checkout as workspace, not global", () => {
    const source = detectInstallSource("/Users/dev/Code/uploads/packages/uploads/dist/cli.js");
    expect(source.kind).toBe("workspace");
  });

  it("classifies a local project dependency as unknown", () => {
    const source = detectInstallSource(
      "/Users/dev/Code/app/node_modules/@buildinternet/uploads/dist/cli.js",
    );
    expect(source.kind).toBe("unknown");
  });

  it("prefers the npx marker over the global marker", () => {
    const source = detectInstallSource(
      "/Users/dev/.npm/_npx/a1b2c3/lib/node_modules/@buildinternet/uploads/dist/cli.js",
    );
    expect(source.kind).toBe("npx");
  });

  it("falls back to npm for a non-global kind", () => {
    const source = detectInstallSource("/Users/dev/Code/uploads/packages/uploads/dist/cli.js");
    expect(source.manager).toBe("npm");
  });

  // Windows npm installs globally to <prefix>\node_modules with no `lib` segment,
  // so this covers both the separator normalization and the Windows-only marker.
  it("classifies a Windows npm global install, normalizing separators", () => {
    const source = detectInstallSource(
      "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@buildinternet\\uploads\\dist\\cli.js",
    );
    expect(source.kind).toBe("global");
    expect(source.manager).toBe("npm");
  });
});
