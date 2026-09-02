/**
 * putObject/deleteObject ↔ github_attachments index wiring (issue #934,
 * phase 1). Uses makePosterEnv's UsageFakeD1, which backs a real
 * file_metadata + github_attachments table.
 */
import { describe, expect, it } from "vitest";
import { putObject } from "../src/files-core";
import { ghPrivateAttachmentKey } from "../src/github-comment-render";
import { getOrMintPrefixId } from "../src/github-private-prefixes";
import { makePosterEnv, PNG, WORKSPACE } from "./poster-fixtures";

describe("putObject → attachment index", () => {
  it("indexes a plain gh attachment key with source 'put'", async () => {
    const { env, db, ws } = makePosterEnv();
    const key = "gh/acme/web/pull/12/hero.png";
    await putObject(env, ws, key, PNG, WORKSPACE);
    expect(db.attachmentIndex.get(`${WORKSPACE}\0${key}`)).toMatchObject({
      workspace: WORKSPACE,
      repo: "acme/web",
      kind: "pull",
      num: 12,
      object_key: key,
      prefix_id: null,
      lane_id: null,
      source: "put",
      detached_at: null,
    });
  });

  it("indexes a private key, taking the repo from the prefix id's owner", async () => {
    const { env, db, ws } = makePosterEnv();
    const id = await getOrMintPrefixId(env.DB, "acme/web", "feat-x");
    const key = ghPrivateAttachmentKey(id, { repo: "acme/web", kind: "pull", num: 12 }, "hero.png");
    await putObject(env, ws, key, PNG, WORKSPACE);
    expect(db.attachmentIndex.get(`${WORKSPACE}\0${key}`)).toMatchObject({
      repo: "acme/web",
      prefix_id: id,
      num: 12,
      source: "put",
    });
  });

  it("ignores a client-supplied gh.repo/gh.ref naming another repo", async () => {
    const { env, db, ws } = makePosterEnv();
    const key = "gh/acme/web/pull/12/hero.png";
    await putObject(env, ws, key, PNG, WORKSPACE, {
      metadata: {
        "gh.repo": "evil/other",
        "gh.kind": "pull",
        "gh.number": "999",
        "gh.ref": "evil/other#999",
      },
    });
    expect(db.attachmentIndex.get(`${WORKSPACE}\0${key}`)).toMatchObject({
      repo: "acme/web",
      num: 12,
    });
  });

  it("writes no row for non-attachment keys (bare uploads, branch staging, ingest)", async () => {
    const { env, db, ws } = makePosterEnv();
    await putObject(env, ws, "screenshots/shot.png", PNG, WORKSPACE);
    await putObject(env, ws, "gh/acme/web/branch/feat-x/shot.png", PNG, WORKSPACE);
    await putObject(env, ws, "gh/acme-web/pull-12/asset-1.png", PNG, WORKSPACE);
    expect(db.attachmentIndex.size).toBe(0);
  });

  it("re-putting the same key upserts rather than duplicating", async () => {
    const { env, db, ws } = makePosterEnv();
    const key = "gh/acme/web/pull/12/hero.png";
    await putObject(env, ws, key, PNG, WORKSPACE);
    await putObject(env, ws, key, PNG, WORKSPACE);
    expect(db.attachmentIndex.size).toBe(1);
  });
});
