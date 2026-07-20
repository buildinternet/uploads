/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { gatherCommentBody, upsertBotComment } from "./github-comment";
import { ATTACHMENTS_MARKER } from "./github-comment-render";
import { addExternalReference, addGalleryItem, createGallery } from "./galleries";
import type { WorkspaceRecord } from "./workspace";
import { FakeR2Bucket } from "../test/fake-r2";
import { FakeKv } from "../test/fake-kv";
import { SqliteD1, database } from "../test/helpers/sqlite-d1";

const MIGRATION = "migrations/20260711180000_galleries.sql";
const PRAGMAS = ["PRAGMA foreign_keys = ON"];
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeTestEnv() {
  const sqlite = new SqliteD1(MIGRATION, PRAGMAS);
  const bucket = new FakeR2Bucket();
  const kv = new FakeKv();
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
    GITHUB_CACHE: kv,
  } as unknown as Env;
  return { env, ws, workspaceName: "acme", bucket, kv, sqlite };
}

/** Generate a throwaway RSA key and return its PKCS#8 PEM (mirrors github-app.test.ts's testKeyPair). */
async function testPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

function fakeFetch(routes: Record<string, (init: RequestInit) => Response>): typeof fetch {
  return (async (url: string, init: RequestInit = {}) => {
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) return handler(init);
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
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

describe("upsertBotComment", () => {
  it("creates the comment when no marker comment exists", async () => {
    const { env } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    const fetchImpl = fakeFetch({
      "/access_tokens": () => new Response(JSON.stringify({ token: "t" }), { status: 201 }),
      "/issues/12/comments": (init) =>
        init.method === "POST"
          ? new Response(JSON.stringify({ html_url: "https://github.com/acme/web/pull/12#c1" }), {
              status: 201,
            })
          : new Response(JSON.stringify([]), { status: 200 }),
    });
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "BODY",
      fetchImpl,
    );
    expect(res).toEqual({
      action: "created",
      commentUrl: "https://github.com/acme/web/pull/12#c1",
    });
  });

  it("patches the existing marker comment", async () => {
    const { env } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    const fetchImpl = fakeFetch({
      "/access_tokens": () => new Response(JSON.stringify({ token: "t" }), { status: 201 }),
      "/issues/12/comments": () =>
        new Response(
          JSON.stringify([{ id: 7, body: `x ${ATTACHMENTS_MARKER} y`, html_url: "u" }]),
          {
            status: 200,
          },
        ),
      "/issues/comments/7": () =>
        new Response(JSON.stringify({ html_url: "https://github.com/acme/web/pull/12#c7" }), {
          status: 200,
        }),
    });
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "BODY",
      fetchImpl,
    );
    expect(res).toEqual({
      action: "updated",
      commentUrl: "https://github.com/acme/web/pull/12#c7",
    });
  });

  it("tolerates a marker comment authored by someone else — matches on body, not author", async () => {
    const { env } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    const fetchImpl = fakeFetch({
      "/access_tokens": () => new Response(JSON.stringify({ token: "t" }), { status: 201 }),
      "/issues/12/comments": () =>
        new Response(
          JSON.stringify([
            { id: 3, body: "unrelated comment", html_url: "u" },
            { id: 7, body: `${ATTACHMENTS_MARKER}\nold body`, html_url: "u" },
          ]),
          { status: 200 },
        ),
      "/issues/comments/7": () =>
        new Response(JSON.stringify({ html_url: "https://github.com/acme/web/pull/12#c7" }), {
          status: 200,
        }),
    });
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "BODY",
      fetchImpl,
    );
    expect(res).toEqual({
      action: "updated",
      commentUrl: "https://github.com/acme/web/pull/12#c7",
    });
  });

  it("degrades to forbidden on 403 from the write call", async () => {
    const { env } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    const fetchImpl = fakeFetch({
      "/access_tokens": () => new Response(JSON.stringify({ token: "t" }), { status: 201 }),
      "/issues/12/comments": (init) =>
        init.method === "POST"
          ? new Response("no", { status: 403 })
          : new Response(JSON.stringify([]), { status: 200 }),
    });
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "BODY",
      fetchImpl,
    );
    expect(res).toEqual({ degrade: "forbidden" });
  });

  it("degrades to forbidden on 403 from the list call", async () => {
    const { env } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    const fetchImpl = fakeFetch({
      "/access_tokens": () => new Response(JSON.stringify({ token: "t" }), { status: 201 }),
      "/issues/12/comments": () => new Response("no", { status: 403 }),
    });
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "BODY",
      fetchImpl,
    );
    expect(res).toEqual({ degrade: "forbidden" });
  });

  it("degrades to unavailable when the installation token mint fails", async () => {
    const { env } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    const fetchImpl = fakeFetch({
      "/access_tokens": () => new Response("nope", { status: 401 }),
    });
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "BODY",
      fetchImpl,
    );
    expect(res).toEqual({ degrade: "unavailable" });
  });

  it("degrades to unavailable when the write call throws (network error)", async () => {
    const { env, kv } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    // Pre-seed the cached token so no signing/minting is needed for this case.
    await kv.put("ghtok:42", "cached-token");
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (url.includes("/issues/12/comments") && init.method !== "POST") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "BODY",
      fetchImpl,
    );
    expect(res).toEqual({ degrade: "unavailable" });
  });
});
