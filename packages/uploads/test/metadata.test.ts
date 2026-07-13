import { describe, expect, it } from "vitest";
import { UsageError } from "../src/cli-args.js";
import { parseMetaFlags, parseMetaPair, validateMetaEntry } from "../src/metadata.js";

describe("parseMetaPair", () => {
  it("splits on the first '=' only", () => {
    expect(parseMetaPair("url=https://example.com/a?b=c")).toEqual([
      "url",
      "https://example.com/a?b=c",
    ]);
  });

  it("rejects a pair with no '='", () => {
    expect(() => parseMetaPair("nokeyvalue")).toThrow(UsageError);
  });

  it("rejects an invalid key", () => {
    expect(() => parseMetaPair("Bad-Key=x")).toThrow(UsageError);
    expect(() => parseMetaPair("1abc=x")).toThrow(UsageError);
  });

  it("accepts a dot-namespaced key", () => {
    expect(parseMetaPair("gh.repo=buildinternet/uploads")).toEqual([
      "gh.repo",
      "buildinternet/uploads",
    ]);
  });

  it("rejects the reserved content-sha256 key", () => {
    expect(() => parseMetaPair("content-sha256=abc")).toThrow(UsageError);
  });

  it("rejects an empty value", () => {
    expect(() => parseMetaPair("app=")).toThrow(UsageError);
  });

  it("rejects a value over 512 chars", () => {
    expect(() => parseMetaPair(`app=${"x".repeat(513)}`)).toThrow(UsageError);
  });

  it("accepts a value at exactly 512 chars", () => {
    const value = "x".repeat(512);
    expect(parseMetaPair(`app=${value}`)).toEqual(["app", value]);
  });

  it("rejects a non-printable-ASCII value", () => {
    expect(() => parseMetaPair("app=café")).toThrow(UsageError);
  });
});

describe("validateMetaEntry", () => {
  it("does not throw for a valid pair", () => {
    expect(() => validateMetaEntry("page", "settings")).not.toThrow();
  });
});

describe("parseMetaFlags", () => {
  it("parses multiple pairs into a map", () => {
    expect(parseMetaFlags(["app=myapp", "page=settings"])).toEqual({
      app: "myapp",
      page: "settings",
    });
  });

  it("returns an empty map for no pairs", () => {
    expect(parseMetaFlags([])).toEqual({});
  });

  it("last write wins for a duplicate key in the same batch", () => {
    expect(parseMetaFlags(["app=one", "app=two"])).toEqual({ app: "two" });
  });

  it("rejects more than 24 pairs", () => {
    const pairs = Array.from({ length: 25 }, (_, i) => `k${i}=v`);
    expect(() => parseMetaFlags(pairs)).toThrow(UsageError);
  });

  it("fails fast on the first invalid pair", () => {
    expect(() => parseMetaFlags(["ok=1", "Bad=2"])).toThrow(UsageError);
  });
});
