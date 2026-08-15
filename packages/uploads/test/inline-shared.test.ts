import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("inline-shared", () => {
  it("keeps generated CLI copies in sync with the workspace packages", () => {
    expect(() =>
      execFileSync(process.execPath, ["scripts/inline-shared.mjs", "--check"], {
        cwd: cliRoot,
        encoding: "utf8",
      }),
    ).not.toThrow();
  });
});
