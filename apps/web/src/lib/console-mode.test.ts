import { describe, expect, it } from "vitest";
import { resolveConsoleMode } from "./console-mode";

function flags(value: string | Error) {
  return {
    getStringValue: async (_key: string, defaultValue: string) => {
      if (value instanceof Error) throw value;
      return value || defaultValue;
    },
  };
}

describe("resolveConsoleMode", () => {
  it("defaults to linked-only with no flag binding and no env var", async () => {
    expect(await resolveConsoleMode({})).toBe("linked-only");
  });

  it("uses CONSOLE_MODE when there is no flag binding", async () => {
    expect(await resolveConsoleMode({ CONSOLE_MODE: "public" })).toBe("public");
  });

  it("treats an invalid CONSOLE_MODE as linked-only", async () => {
    expect(await resolveConsoleMode({ CONSOLE_MODE: "banana" })).toBe("linked-only");
  });

  it("prefers the flag over the env var", async () => {
    expect(await resolveConsoleMode({ CONSOLE_MODE: "public", FLAGS: flags("off") })).toBe("off");
  });

  it("falls back to the env var on an invalid flag value", async () => {
    expect(await resolveConsoleMode({ CONSOLE_MODE: "public", FLAGS: flags("banana") })).toBe(
      "public",
    );
  });

  it("falls back to the env var when the binding throws", async () => {
    expect(await resolveConsoleMode({ CONSOLE_MODE: "off", FLAGS: flags(new Error("boom")) })).toBe(
      "off",
    );
  });
});
