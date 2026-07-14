import { describe, expect, it } from "vitest";
import { UsageError } from "../src/cli-args.js";
import {
  parseMetaFlags,
  parseMetaPair,
  validateMetaEntry,
  validateMetaMap,
} from "../src/metadata.js";

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

  it("rejects the reserved visibility key", () => {
    expect(() => parseMetaPair("visibility=private")).toThrow(UsageError);
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

  it("rejects a batch whose total key+value bytes exceed 8192", () => {
    // 17 pairs x (k<i> + 512-char value) ≈ 8.7 KB > 8192, each pair individually valid.
    const pairs = Array.from({ length: 17 }, (_, i) => `k${i}=${"x".repeat(512)}`);
    expect(() => parseMetaFlags(pairs)).toThrow(/8192-byte limit/);
  });

  it("accepts a batch just under the byte cap", () => {
    // 15 pairs x ~514 bytes ≈ 7.7 KB < 8192.
    const pairs = Array.from({ length: 15 }, (_, i) => `k${i}=${"x".repeat(510)}`);
    expect(() => parseMetaFlags(pairs)).not.toThrow();
  });
});

describe("validateMetaMap", () => {
  it("does not throw for a valid map", () => {
    expect(() => validateMetaMap({ app: "myapp", page: "settings" })).not.toThrow();
  });

  it("accepts an empty map", () => {
    expect(() => validateMetaMap({})).not.toThrow();
  });

  it("rejects an invalid key", () => {
    expect(() => validateMetaMap({ "Bad-Key": "x" })).toThrow(UsageError);
  });

  it("rejects the reserved content-sha256 key", () => {
    expect(() => validateMetaMap({ "content-sha256": "abc" })).toThrow(UsageError);
  });

  it("rejects the reserved visibility key", () => {
    expect(() => validateMetaMap({ visibility: "private" })).toThrow(UsageError);
  });

  it("preserves a value containing '=' (no re-split corruption)", () => {
    expect(() => validateMetaMap({ url: "https://example.com/a?b=c" })).not.toThrow();
  });

  it("rejects more than 24 keys", () => {
    const meta = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, "v"]));
    expect(() => validateMetaMap(meta)).toThrow(UsageError);
  });

  it("rejects a map whose total key+value bytes exceed 8192", () => {
    const meta = Object.fromEntries(
      Array.from({ length: 17 }, (_, i) => [`k${i}`, "x".repeat(512)]),
    );
    expect(() => validateMetaMap(meta)).toThrow(/8192-byte limit/);
  });
});
