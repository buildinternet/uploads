/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { gatherCommentBody } from "./github-comment";
import { ATTACHMENTS_MARKER } from "./github-comment-render";
import { addExternalReference, addGalleryItem, createGallery } from "./galleries";
import type { WorkspaceRecord } from "./workspace";
import { FakeR2Bucket } from "../test/fake-r2";
import { SqliteD1, database } from "../test/helpers/sqlite-d1";

const MIGRATION = "migrations/20260711180000_galleries.sql";
const PRAGMAS = ["PRAGMA foreign_keys = ON"];
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeTestEnv() {
  const sqlite = new SqliteD1(MIGRATION, PRAGMAS);
  const bucket = new FakeR2Bucket();
  const ws: WorkspaceRecord = {
    provider: "r2",
    bucket: "shared",
    binding: "UPLOADS_DEFAULT",
    prefix: "acme/",
    publicBaseUrl: "https://storage.uploads.sh",
  };
  const env = {
    DB: database(sqlite),
    WEB_ORIGIN: "https://uploads.test",
    UPLOADS_DEFAULT: bucket,
  } as unknown as Env;
  return { env, ws, workspaceName: "acme", bucket, sqlite };
}

describe("gatherCommentBody", () => {
  it("returns skip when the workspace has no attachments and no galleries", async () => {
    const { env, ws, workspaceName } = makeTestEnv();
    const result = await gatherCommentBody(env, ws, workspaceName, {
      repo: "acme/web",
      num: 12,
      kind: "pull",
    });
    expect(result).toEqual({ skip: true });
  });

  it("renders the workspace's own attachments under the gh prefix", async () => {
    const { env, ws, workspaceName, bucket } = makeTestEnv();
    await bucket.put("acme/gh/acme/web/pull/12/hero.png", PNG, {
      httpMetadata: { contentType: "image/png" },
    });
    const result = await gatherCommentBody(env, ws, workspaceName, {
      repo: "acme/web",
      num: 12,
      kind: "pull",
    });
    expect(result.skip).toBe(false);
    if (result.skip) return;
    expect(result.body.startsWith(ATTACHMENTS_MARKER)).toBe(true);
    expect(result.body).toContain("hero.png");
    expect(result.count).toBe(1);
  });

  it("renders galleries linked to the PR via an external reference, scoped to the calling workspace", async () => {
    const { env, ws, workspaceName, bucket } = makeTestEnv();
    await bucket.put("acme/screenshots/one.png", PNG, {
      httpMetadata: { contentType: "image/png" },
    });
    const created = await createGallery(env.DB, {
      workspace: workspaceName,
      title: "Launch media",
    });
    if (created.status !== "ok") throw new Error(`create failed: ${created.status}`);
    const item = await addGalleryItem(env.DB, workspaceName, created.value.id, {
      expectedVersion: 1,
      objectKey: "screenshots/one.png",
    });
    if (item.status !== "ok") throw new Error(`add item failed: ${item.status}`);
    const reference = await addExternalReference(env.DB, workspaceName, created.value.id, {
      expectedVersion: 2,
      provider: "github",
      resourceType: "item",
      normalizedKey: "github:item:acme/web#12",
      locator: { owner: "acme", repository: "web", number: 12 },
      canonicalUrl: "https://github.com/acme/web/issues/12",
    });
    if (reference.status !== "ok") throw new Error(`add reference failed: ${reference.status}`);

    // A different workspace's gallery, linked to the same PR — must not leak in.
    const otherCreated = await createGallery(env.DB, { workspace: "other-ws", title: "Not ours" });
    if (otherCreated.status !== "ok") throw new Error("other create failed");
    const otherReference = await addExternalReference(env.DB, "other-ws", otherCreated.value.id, {
      expectedVersion: 1,
      provider: "github",
      resourceType: "item",
      normalizedKey: "github:item:acme/web#12",
      locator: { owner: "acme", repository: "web", number: 12 },
      canonicalUrl: "https://github.com/acme/web/issues/12",
    });
    if (otherReference.status !== "ok") throw new Error("other reference failed");

    const result = await gatherCommentBody(env, ws, workspaceName, {
      repo: "acme/web",
      num: 12,
      kind: "pull",
    });
    expect(result.skip).toBe(false);
    if (result.skip) return;
    expect(result.body.startsWith(ATTACHMENTS_MARKER)).toBe(true);
    expect(result.body).toContain("Launch media");
    expect(result.body).not.toContain("Not ours");
    expect(result.count).toBe(1);
  });
});
