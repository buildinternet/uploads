/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { parseAttachmentKey } from "../src/github-attachment-index";

describe("parseAttachmentKey", () => {
  it("parses a plain gh key and recovers the sanitized repo", () => {
    expect(parseAttachmentKey("gh/Acme/Web/pull/12/hero.png")).toEqual({
      kind: "pull",
      num: 12,
      prefixId: null,
      repo: "acme/web",
    });
    expect(parseAttachmentKey("gh/acme/web/issues/3/a.png")).toEqual({
      kind: "issues",
      num: 3,
      prefixId: null,
      repo: "acme/web",
    });
  });

  it("parses a private key but cannot recover the repo", () => {
    const id = "a".repeat(32);
    expect(parseAttachmentKey(`gh/private/${id}/pull/12/hero.png`)).toEqual({
      kind: "pull",
      num: 12,
      prefixId: id,
      repo: null,
    });
  });

  it("returns undefined for ingest keys (plain and private)", () => {
    expect(parseAttachmentKey("gh/acme-web/pull-12/asset-1.png")).toBeUndefined();
    expect(
      parseAttachmentKey(`gh/private/${"b".repeat(32)}/ingest/pull-12/asset-1.png`),
    ).toBeUndefined();
  });

  it("returns undefined for branch-staged, malformed, and non-gh keys", () => {
    expect(parseAttachmentKey("gh/acme/web/branch/feat-x/hero.png")).toBeUndefined();
    expect(parseAttachmentKey(`gh/private/${"c".repeat(32)}/branch/hero.png`)).toBeUndefined();
    expect(parseAttachmentKey("gh/acme/web/pull/0/hero.png")).toBeUndefined();
    expect(parseAttachmentKey("gh/acme/web/pull/12/")).toBeUndefined();
    expect(parseAttachmentKey("gh/acme/web/pull/abc/hero.png")).toBeUndefined();
    expect(parseAttachmentKey("f/abc/hero.png")).toBeUndefined();
    expect(parseAttachmentKey("gh/private/short/pull/12/hero.png")).toBeUndefined();
  });
});
