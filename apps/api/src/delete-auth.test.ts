import { describe, expect, it } from "vitest";
import { attachmentCommentTarget, callerOwnsGithubObject } from "./delete-auth";
import type { UploaderIdentity } from "./uploader-identity";

const user: UploaderIdentity = { kind: "user", userId: "user-1" };
const service: UploaderIdentity = { kind: "service", tokenId: "tok", label: "ci" };
const none: UploaderIdentity = { kind: "none" };
const ghKey = "gh/acme/web/pull/12/shot.png";

describe("callerOwnsGithubObject", () => {
  it("matches the user who uploaded a gh object", () => {
    expect(callerOwnsGithubObject(ghKey, { "gh.uploader-id": "user-1" }, user)).toBe(true);
  });

  it("refuses a different user, a service token, and a legacy identity", () => {
    expect(callerOwnsGithubObject(ghKey, { "gh.uploader-id": "other" }, user)).toBe(false);
    expect(callerOwnsGithubObject(ghKey, { "gh.uploader-id": "user-1" }, service)).toBe(false);
    expect(callerOwnsGithubObject(ghKey, { "gh.uploader-id": "user-1" }, none)).toBe(false);
    expect(callerOwnsGithubObject(ghKey, { "gh.uploader-id": "user-1" }, undefined)).toBe(false);
  });

  it("refuses a non-gh key and an empty uploader id", () => {
    expect(callerOwnsGithubObject("screenshots/a.png", { "gh.uploader-id": "user-1" }, user)).toBe(
      false,
    );
    expect(callerOwnsGithubObject(ghKey, { "gh.uploader-id": "" }, user)).toBe(false);
    expect(callerOwnsGithubObject("gh/acme/web/branch/feat/shot.png", {}, user)).toBe(false);
  });
});

describe("attachmentCommentTarget", () => {
  it("reads a plain pull or issue key", () => {
    expect(attachmentCommentTarget(ghKey, {})).toEqual({
      repo: "acme/web",
      kind: "pull",
      num: 12,
    });
    expect(attachmentCommentTarget("gh/acme/web/issues/4/log.txt", {})).toEqual({
      repo: "acme/web",
      kind: "issues",
      num: 4,
    });
  });

  it("needs gh.repo for a private attachment and ignores branch keys", () => {
    const id = "a".repeat(32);
    expect(attachmentCommentTarget(`gh/private/${id}/pull/9/shot.png`, {})).toBeUndefined();
    expect(
      attachmentCommentTarget(`gh/private/${id}/pull/9/shot.png`, { "gh.repo": "Acme/Web" }),
    ).toEqual({ repo: "Acme/Web", kind: "pull", num: 9 });
    expect(attachmentCommentTarget("gh/acme/web/branch/feat/shot.png", {})).toBeUndefined();
  });
});
