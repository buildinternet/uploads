import { describe, expect, it } from "vitest";
import { flagString, flagValues, parseCommandArgs } from "../src/cli-args.js";

describe("parseCommandArgs repeatable flags", () => {
  it("collapses a single occurrence into a one-element array via flagValues", () => {
    const { flags } = parseCommandArgs(["--meta", "app=x"]);
    expect(flagValues(flags, "--meta")).toEqual(["app=x"]);
    expect(flagString(flags, "--meta")).toBe("app=x");
  });

  it("collects repeated occurrences into an array in argument order", () => {
    const { flags } = parseCommandArgs(["--meta", "app=x", "--meta", "page=y"]);
    expect(flagValues(flags, "--meta")).toEqual(["app=x", "page=y"]);
  });

  it("flagString returns undefined once a flag has repeated (avoids silently using only the last value)", () => {
    const { flags } = parseCommandArgs(["--meta", "app=x", "--meta", "page=y"]);
    expect(flagString(flags, "--meta")).toBeUndefined();
  });

  it("returns an empty array when the flag is absent", () => {
    const { flags } = parseCommandArgs(["--other", "1"]);
    expect(flagValues(flags, "--meta")).toEqual([]);
  });

  it("supports repeated --flag=value form", () => {
    const { flags } = parseCommandArgs(["--meta=app=x", "--meta=page=y"]);
    expect(flagValues(flags, "--meta")).toEqual(["app=x", "page=y"]);
  });

  it("does not disturb unrelated single-occurrence flags", () => {
    const { flags } = parseCommandArgs(["--meta", "app=x", "--prefix", "screenshots/"]);
    expect(flagString(flags, "--prefix")).toBe("screenshots/");
  });
});
