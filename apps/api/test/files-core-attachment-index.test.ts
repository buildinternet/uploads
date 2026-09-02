/**
 * putObject/deleteObject ↔ github_attachments index wiring (issue #934,
 * phase 1). Uses makePosterEnv's UsageFakeD1, which backs a real
 * file_metadata + github_attachments table.
 */
import { describe, expect, it } from "vitest";
import { type D1Queryable } from "../src/db-session";
import { detachAttachment } from "../src/github-attachment-index";
import { deleteObject, putObject } from "../src/files-core";
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

  it("attributes the row to opts.attachment's source and repo when the caller supplies one", async () => {
    const { env, db, ws } = makePosterEnv();
    const key = "gh/acme/web/pull/12/hero.png";
    await putObject(env, ws, key, PNG, WORKSPACE, {
      attachment: { source: "attach", repo: "Acme/Web-Site" },
    });
    expect(db.attachmentIndexUpserts).toBe(1);
    expect(db.attachmentIndex.get(`${WORKSPACE}\0${key}`)).toMatchObject({
      source: "attach",
      repo: "acme/web-site",
      num: 12,
    });
  });

  it("a caller-supplied non-put source clears detached_at, exactly like a re-record would", async () => {
    const { env, db, ws } = makePosterEnv();
    const key = "gh/acme/web/pull/12/hero.png";
    await putObject(env, ws, key, PNG, WORKSPACE);
    await detachAttachment(
      db as unknown as D1Queryable,
      WORKSPACE,
      key,
      new Date("2026-09-05T00:00:00.000Z"),
    );

    await putObject(env, ws, key, PNG, WORKSPACE, {
      attachment: { source: "adopt", repo: "acme/web" },
    });

    expect(db.attachmentIndex.get(`${WORKSPACE}\0${key}`)).toMatchObject({
      source: "adopt",
      detached_at: null,
    });
  });

  it("a detached row survives a re-put of the same key (putObject writes source 'put')", async () => {
    const { env, db, ws } = makePosterEnv();
    const key = "gh/acme/web/pull/12/hero.png";
    await putObject(env, ws, key, PNG, WORKSPACE);
    await detachAttachment(
      db as unknown as D1Queryable,
      WORKSPACE,
      key,
      new Date("2026-09-05T00:00:00.000Z"),
    );
    expect(db.attachmentIndex.get(`${WORKSPACE}\0${key}`)).toMatchObject({
      detached_at: "2026-09-05T00:00:00.000Z",
    });

    await putObject(env, ws, key, PNG, WORKSPACE);

    expect(db.attachmentIndex.get(`${WORKSPACE}\0${key}`)).toMatchObject({
      source: "put",
      detached_at: "2026-09-05T00:00:00.000Z",
    });
  });
});

describe("putObject → attachment index scheduling", () => {
  it("issues the index write with the other post-write D1 bookkeeping, not serially after it", async () => {
    const { env, ws } = makePosterEnv();
    const statements: string[] = [];
    const db = env.DB as unknown as { prepare: (sql: string) => unknown };
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      statements.push(sql.replace(/\s+/g, " ").trim());
      return realPrepare(sql);
    };

    await putObject(env, ws, "gh/acme/web/pull/12/hero.png", PNG, WORKSPACE);

    const indexAt = statements.findIndex((sql) => sql.startsWith("INSERT INTO github_attachments"));
    const hashAt = statements.findIndex((sql) => sql.includes("INSERT INTO file_content_hash"));
    expect(indexAt).toBeGreaterThanOrEqual(0);
    expect(hashAt).toBeGreaterThanOrEqual(0);
    // The index write now rides in putObject's post-write `Promise.all`,
    // which runs before the metadata/content-hash tail — so it overlaps
    // those round trips instead of adding its own after them.
    expect(indexAt).toBeLessThan(hashAt);
  });
});

describe("deleteObject → attachment index", () => {
  it("removes the index row alongside the object's metadata", async () => {
    const { env, db, ws } = makePosterEnv();
    const key = "gh/acme/web/pull/12/hero.png";
    await putObject(env, ws, key, PNG, WORKSPACE);
    expect(db.attachmentIndex.get(`${WORKSPACE}\0${key}`)).toBeDefined();

    await deleteObject(env, ws, key, WORKSPACE);
    expect(db.attachmentIndex.get(`${WORKSPACE}\0${key}`)).toBeUndefined();
  });
});

describe("deleteObject → attachment index on a failed lane delete", () => {
  it("keeps the index row when the storage delete throws, since the object still exists", async () => {
    const { env, db, ws, bucket } = makePosterEnv();
    const key = "gh/acme/web/pull/12/hero.png";
    await putObject(env, ws, key, PNG, WORKSPACE);
    bucket.delete = async () => {
      throw new Error("lane delete failed");
    };

    await expect(deleteObject(env, ws, key, WORKSPACE)).rejects.toThrow("lane delete failed");
    expect(db.attachmentIndex.get(`${WORKSPACE}\0${key}`)).toBeDefined();
  });
});
