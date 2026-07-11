import { describe, expect, it } from "vitest";
import {
  BUILTIN_DESTINATIONS,
  keyMatchesDestination,
  resolveDestinationRoot,
  resolvePutPrefix,
} from "../src/destinations.js";

describe("resolveDestinationRoot", () => {
  it("resolves built-ins", () => {
    expect(resolveDestinationRoot("screenshots")).toBe(BUILTIN_DESTINATIONS.screenshots);
    expect(resolveDestinationRoot("gh")).toBe("gh");
    expect(resolveDestinationRoot("f")).toBe("f");
  });

  it("rejects unknown ids", () => {
    expect(() => resolveDestinationRoot("tmp")).toThrow(/unknown destination/);
  });
});

describe("keyMatchesDestination", () => {
  it("matches root and nested keys", () => {
    expect(keyMatchesDestination("screenshots/a.png", "screenshots")).toBe(true);
    expect(keyMatchesDestination("gh/o/r/pull/1/a.png", "gh")).toBe(true);
  });

  it("rejects other roots", () => {
    expect(keyMatchesDestination("tmp/a.png", "screenshots")).toBe(false);
  });
});

describe("resolvePutPrefix", () => {
  it("returns destination root", () => {
    expect(resolvePutPrefix({ destination: "screenshots" })).toBe("screenshots");
  });

  it("passes through plain prefix when no destination", () => {
    expect(resolvePutPrefix({ prefix: "custom" })).toBe("custom");
  });

  it("rejects destination other than gh for attachments", () => {
    expect(() => resolvePutPrefix({ destination: "screenshots", ghAttachment: true })).toThrow(
      /must be gh/,
    );
  });

  it("rejects conflicting prefix", () => {
    expect(() => resolvePutPrefix({ destination: "screenshots", prefix: "other" })).toThrow(
      /conflicts/,
    );
  });

  it("rejects key outside destination", () => {
    expect(() => resolvePutPrefix({ destination: "screenshots", key: "tmp/a.png" })).toThrow(
      /must start with destination root/,
    );
  });
});
