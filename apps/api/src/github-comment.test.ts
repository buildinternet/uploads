/// <reference types="node" />

import { describe, expect, it } from "vitest";
import { gatherCommentBody, upsertBotComment } from "./github-comment";
import { ATTACHMENTS_MARKER, attachmentsMarker } from "./github-comment-render";
import { addExternalReference, addGalleryItem, createGallery } from "./galleries";
import { replaceFileMetadata, setServerFileMetadata } from "./file-metadata";
import { objectPublicUrls, storageConfig } from "./storage";
import { posterKeyFor } from "./poster";
import type { WorkspaceRecord } from "./workspace";
import { FakeR2Bucket } from "../test/fake-r2";
import { FakeKv } from "../test/fake-kv";
import { SqliteD1, database } from "../test/helpers/sqlite-d1";

const MIGRATION = [
  "migrations/20260711180000_galleries.sql",
  "migrations/20260713210559_file_metadata.sql",
];
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
  it("returns the empty-state body (no skip) when nothing is staged", async () => {
    const { env, ws, workspaceName } = makeTestEnv();
    const result = await gatherCommentBody(env, ws, workspaceName, {
      repo: "acme/web",
      num: 12,
      kind: "pull",
    });
    expect(result.count).toBe(0);
    expect(result.body).toContain("_No attachments are currently associated");
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
    expect(result.body.startsWith(attachmentsMarker(workspaceName))).toBe(true);
    expect(result.body).toContain("hero.png");
    expect(result.count).toBe(1);
  });

  it("links an attachment to its /f/ file page by default (flag absent)", async () => {
    const { env, ws, workspaceName, bucket } = makeTestEnv();
    await bucket.put("acme/gh/acme/web/pull/12/hero.png", PNG, {
      httpMetadata: { contentType: "image/png" },
    });
    const result = await gatherCommentBody(env, { ...ws, name: workspaceName }, workspaceName, {
      repo: "acme/web",
      num: 12,
      kind: "pull",
    });
    expect(result.body).toContain(`/f/${workspaceName}/`);
  });

  it("links an attachment to its /f/ file page when the flag is explicitly true", async () => {
    const { env, ws, workspaceName, bucket } = makeTestEnv();
    await bucket.put("acme/gh/acme/web/pull/12/hero.png", PNG, {
      httpMetadata: { contentType: "image/png" },
    });
    const result = await gatherCommentBody(
      env,
      { ...ws, name: workspaceName, githubCommentLinkToFilePage: true },
      workspaceName,
      { repo: "acme/web", num: 12, kind: "pull" },
    );
    expect(result.body).toContain(`/f/${workspaceName}/`);
  });

  it("links an attachment to the raw url when githubCommentLinkToFilePage is false", async () => {
    const { env, ws, workspaceName, bucket } = makeTestEnv();
    await bucket.put("acme/gh/acme/web/pull/12/hero.png", PNG, {
      httpMetadata: { contentType: "image/png" },
    });
    const result = await gatherCommentBody(
      env,
      { ...ws, name: workspaceName, githubCommentLinkToFilePage: false },
      workspaceName,
      { repo: "acme/web", num: 12, kind: "pull" },
    );
    expect(result.body).not.toContain(`/f/${workspaceName}/`);
    // Falls back to the raw storage url.
    expect(result.body).toContain("storage.uploads.sh");
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
    expect(result.body.startsWith(attachmentsMarker(workspaceName))).toBe(true);
    expect(result.body).toContain("Launch media");
    expect(result.body).not.toContain("Not ours");
    expect(result.count).toBe(1);
  });
});

describe("gatherCommentBody attachment metadata (issue #365)", () => {
  async function seed(env: Env, bucket: FakeR2Bucket, meta: Record<string, string>) {
    await bucket.put("acme/gh/acme/web/pull/12/before.webp", PNG);
    await replaceFileMetadata(env.DB, "acme", "gh/acme/web/pull/12/before.webp", meta);
  }

  it("renders path and state from D1 on the attachment", async () => {
    const { env, ws, workspaceName, bucket } = makeTestEnv();
    await seed(env, bucket, { path: "/settings", state: "before" });

    const result = await gatherCommentBody(env, ws, workspaceName, {
      repo: "acme/web",
      num: 12,
      kind: "pull",
    });

    expect(result.body).toContain("<sub>/settings · before</sub>");
  });

  it("never fetches or renders EXIF-derived keys", async () => {
    const { env, ws, workspaceName, bucket } = makeTestEnv();
    await seed(env, bucket, {
      path: "/settings",
      device: "iPhone 15 Pro",
      software: "Adobe Photoshop 26.0",
    });

    const result = await gatherCommentBody(env, ws, workspaceName, {
      repo: "acme/web",
      num: 12,
      kind: "pull",
    });

    const body = result.body;
    expect(body).toContain("<sub>/settings</sub>");
    expect(body).not.toContain("iPhone");
    expect(body).not.toContain("Photoshop");
  });

  it("renders exactly as before when the workspace has no metadata", async () => {
    const { env, ws, workspaceName, bucket } = makeTestEnv();
    await bucket.put("acme/gh/acme/web/pull/12/before.webp", PNG);

    const result = await gatherCommentBody(env, ws, workspaceName, {
      repo: "acme/web",
      num: 12,
      kind: "pull",
    });

    expect(result.body).not.toContain("<sub>/");
  });

  it("skips the D1 read entirely when githubCommentShowMetadata is false", async () => {
    const { env, ws, workspaceName, bucket } = makeTestEnv();
    await seed(env, bucket, { path: "/settings", state: "before" });

    let metadataQueries = 0;
    // Delegate explicitly rather than spreading `env.DB` — it is a class
    // instance, so a spread would drop its prototype methods.
    const spied = {
      prepare: (sql: string) => {
        if (sql.includes("FROM file_metadata")) metadataQueries++;
        return env.DB.prepare(sql);
      },
      batch: (statements: D1PreparedStatement[]) => env.DB.batch(statements),
    } as unknown as D1Database;

    const result = await gatherCommentBody(
      { ...env, DB: spied } as Env,
      { ...ws, githubCommentShowMetadata: false },
      workspaceName,
      { repo: "acme/web", num: 12, kind: "pull" },
    );

    expect(metadataQueries).toBe(0);
    expect(result.body).not.toContain("<sub>/settings");
  });

  it("does not leak another workspace's metadata for the same object key", async () => {
    const { env, ws, workspaceName, bucket } = makeTestEnv();
    await seed(env, bucket, { path: "/settings", state: "before" });

    // A different workspace's metadata on the SAME object key — must not leak
    // into acme's rendered comment. The D1 row is scoped by the `workspace`
    // column, not by anything derived from the object key.
    await replaceFileMetadata(env.DB, "other-ws", "gh/acme/web/pull/12/before.webp", {
      path: "/intruder-path",
      state: "compromised",
    });

    const result = await gatherCommentBody(env, ws, workspaceName, {
      repo: "acme/web",
      num: 12,
      kind: "pull",
    });

    const body = result.body;
    expect(body).toContain("<sub>/settings · before</sub>");
    expect(body).not.toContain("/intruder-path");
    expect(body).not.toContain("compromised");
  });
});

describe("gatherCommentBody poster hydration (issue #299)", () => {
  it("attaches a poster url computed from the key, never from metadata", async () => {
    const { env, ws, workspaceName, bucket } = makeTestEnv();
    const key = "gh/acme/web/pull/12/clip.mp4";
    await bucket.put(`acme/${key}`, PNG, { httpMetadata: { contentType: "video/mp4" } });
    // The real write path (`setServerFileMetadata`) is what generateAndStorePoster
    // (Task 8) uses — this is the only legitimate way `video.poster` gets set.
    await setServerFileMetadata(env.DB, workspaceName, key, { "video.poster": "1" });
    // A hostile row: no client-facing write path can produce this (`video.*` is
    // server-reserved — file-metadata.ts's `isServerMetaKey`), but seed it
    // directly to prove the renderer can't be fooled into using a stored URL
    // even if one somehow existed under a plausible-looking key.
    const hostileAt = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO file_metadata (workspace, object_key, meta_key, meta_value, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(workspaceName, key, "video.poster_hostile", "https://evil.example/x.jpg", hostileAt)
      .run();

    const result = await gatherCommentBody(env, ws, workspaceName, {
      repo: "acme/web",
      num: 12,
      kind: "pull",
    });

    const cfg = await storageConfig(env, ws);
    const expectedUrls = objectPublicUrls(env, cfg, posterKeyFor(key));
    const expectedPosterUrl = expectedUrls.embedUrl ?? expectedUrls.url;
    expect(expectedPosterUrl).toBeTruthy();
    expect(result.body).toContain(expectedPosterUrl as string);
    expect(result.body).not.toContain("evil.example");
  });

  it("leaves posterUrl unset when video.poster is absent", async () => {
    const { env, ws, workspaceName, bucket } = makeTestEnv();
    const key = "gh/acme/web/pull/12/clip.mp4";
    await bucket.put(`acme/${key}`, PNG, { httpMetadata: { contentType: "video/mp4" } });
    // No file_metadata row at all — the common case for every non-video
    // attachment, and for a video whose poster generation was skipped/failed.

    const result = await gatherCommentBody(env, ws, workspaceName, {
      repo: "acme/web",
      num: 12,
      kind: "pull",
    });
    expect(result.body).not.toContain("_internal/posters");
    expect(result.body).toContain("clip.mp4");
  });

  it("carries duration and dimensions onto videoMeta", async () => {
    const { env, ws, workspaceName, bucket } = makeTestEnv();
    const key = "gh/acme/web/pull/12/clip.mp4";
    await bucket.put(`acme/${key}`, PNG, { httpMetadata: { contentType: "video/mp4" } });
    await setServerFileMetadata(env.DB, workspaceName, key, {
      "video.poster": "1",
      "video.duration": "14",
      "video.width": "1920",
      "video.height": "1080",
    });

    const result = await gatherCommentBody(env, ws, workspaceName, {
      repo: "acme/web",
      num: 12,
      kind: "pull",
    });
    // formatDuration(14) === "0:14" (github-comment-render.ts / poster.ts).
    // Task 11's caption format: "▶ Play video · 0:14 · ...". Dimensions feed
    // display width selection rather than appearing verbatim, so duration is
    // the one directly observable proof that videoMeta parsed as numbers.
    expect(result.body).toContain("0:14");
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
      "acme",
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
      "acme",
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
      "acme",
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
      "acme",
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
      "acme",
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
      "acme",
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
      "acme",
      fetchImpl,
    );
    expect(res).toEqual({ degrade: "unavailable" });
  });

  it("uses a cached comment id to PATCH directly, without listing", async () => {
    const { env, kv } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    await kv.put("ghcomment:acme:acme/web#12", "55");
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "t" }), { status: 201 });
      }
      // A cache hit must never list — fail loudly if it does.
      if (url.includes("/issues/12/comments")) throw new Error("listed on cache hit");
      if (url.includes("/issues/comments/55") && init.method === "PATCH") {
        return new Response(
          JSON.stringify({ id: 55, html_url: "https://github.com/acme/web/pull/12#c55" }),
          { status: 200 },
        );
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "BODY",
      "acme",
      fetchImpl,
    );
    expect(res).toEqual({
      action: "updated",
      commentUrl: "https://github.com/acme/web/pull/12#c55",
    });
  });

  it("re-hunts and recreates when the cached comment was deleted (404), refreshing the cache", async () => {
    const { env, kv } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    await kv.put("ghcomment:acme:acme/web#12", "55");
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "t" }), { status: 201 });
      }
      if (url.includes("/issues/comments/55")) return new Response("gone", { status: 404 });
      if (url.includes("/issues/12/comments")) {
        return init.method === "POST"
          ? new Response(
              JSON.stringify({ id: 88, html_url: "https://github.com/acme/web/pull/12#c88" }),
              { status: 201 },
            )
          : new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "BODY",
      "acme",
      fetchImpl,
    );
    expect(res).toEqual({
      action: "created",
      commentUrl: "https://github.com/acme/web/pull/12#c88",
    });
    expect(await kv.get("ghcomment:acme:acme/web#12")).toBe("88");
  });

  it("finds the marker comment beyond the first page and caches its id", async () => {
    const { env, kv } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: "noise" }));
    const fetchImpl = (async (url: string) => {
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "t" }), { status: 201 });
      }
      if (url.includes("&page=2")) {
        return new Response(JSON.stringify([{ id: 777, body: ATTACHMENTS_MARKER }]), {
          status: 200,
        });
      }
      if (url.includes("&page=1")) return new Response(JSON.stringify(fullPage), { status: 200 });
      if (url.includes("/issues/comments/777")) {
        return new Response(
          JSON.stringify({ id: 777, html_url: "https://github.com/acme/web/pull/12#c777" }),
          { status: 200 },
        );
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "BODY",
      "acme",
      fetchImpl,
    );
    expect(res).toEqual({
      action: "updated",
      commentUrl: "https://github.com/acme/web/pull/12#c777",
    });
    expect(await kv.get("ghcomment:acme:acme/web#12")).toBe("777");
  });

  it("caches the id of a freshly created comment", async () => {
    const { env, kv } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    const fetchImpl = fakeFetch({
      "/access_tokens": () => new Response(JSON.stringify({ token: "t" }), { status: 201 }),
      "/issues/12/comments": (init) =>
        init.method === "POST"
          ? new Response(
              JSON.stringify({ id: 99, html_url: "https://github.com/acme/web/pull/12#c99" }),
              { status: 201 },
            )
          : new Response(JSON.stringify([]), { status: 200 }),
    });
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "BODY",
      "acme",
      fetchImpl,
    );
    expect(res).toEqual({
      action: "created",
      commentUrl: "https://github.com/acme/web/pull/12#c99",
    });
    expect(await kv.get("ghcomment:acme:acme/web#12")).toBe("99");
  });

  it("finds a namespaced marker comment first, even when a legacy marker comment also exists", async () => {
    const { env } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    const fetchImpl = fakeFetch({
      "/access_tokens": () => new Response(JSON.stringify({ token: "t" }), { status: 201 }),
      "/issues/12/comments": () =>
        new Response(
          JSON.stringify([
            { id: 1, body: `${ATTACHMENTS_MARKER}\nother workspace's legacy comment` },
            { id: 2, body: `${attachmentsMarker("acme")}\nours` },
          ]),
          { status: 200 },
        ),
      "/issues/comments/2": () =>
        new Response(
          JSON.stringify({ id: 2, html_url: "https://github.com/acme/web/pull/12#c2" }),
          {
            status: 200,
          },
        ),
    });
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "BODY",
      "acme",
      fetchImpl,
    );
    expect(res).toEqual({
      action: "updated",
      commentUrl: "https://github.com/acme/web/pull/12#c2",
    });
  });

  it("adopts a legacy (unnamespaced) marker comment when no namespaced one exists yet", async () => {
    const { env } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    const fetchImpl = fakeFetch({
      "/access_tokens": () => new Response(JSON.stringify({ token: "t" }), { status: 201 }),
      "/issues/12/comments": () =>
        new Response(JSON.stringify([{ id: 5, body: `${ATTACHMENTS_MARKER}\nold body` }]), {
          status: 200,
        }),
      "/issues/comments/5": () =>
        new Response(
          JSON.stringify({ id: 5, html_url: "https://github.com/acme/web/pull/12#c5" }),
          {
            status: 200,
          },
        ),
    });
    // The namespaced marker is already the first line of `body` — patching the
    // legacy comment with it migrates the comment in place.
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      `${attachmentsMarker("acme")}\nnew body`,
      "acme",
      fetchImpl,
    );
    expect(res).toEqual({
      action: "updated",
      commentUrl: "https://github.com/acme/web/pull/12#c5",
    });
  });

  it("uses a distinct cache key per workspace so two workspaces on one repo never collide", async () => {
    const { env, kv } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    await kv.put("ghcomment:acme:acme/web#12", "55");
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "t" }), { status: 201 });
      }
      // A cache hit for "acme" must never be used by a different workspace.
      if (url.includes("/issues/comments/55"))
        throw new Error("wrong workspace's cache entry used");
      if (url.includes("/issues/12/comments")) {
        return init.method === "POST"
          ? new Response(
              JSON.stringify({ id: 66, html_url: "https://github.com/other-ws/web/pull/12#c66" }),
              { status: 201 },
            )
          : new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "BODY",
      "other-ws",
      fetchImpl,
    );
    expect(res).toEqual({
      action: "created",
      commentUrl: "https://github.com/other-ws/web/pull/12#c66",
    });
    expect(await kv.get("ghcomment:other-ws:acme/web#12")).toBe("66");
  });

  it("collapses duplicate marker comments: patches the oldest, deletes the extras (issue #470)", async () => {
    const { env, kv } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    const deleted: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "t" }), { status: 201 });
      }
      if (url.includes("/issues/12/comments")) {
        return new Response(
          JSON.stringify([
            { id: 7, body: `${attachmentsMarker("acme")}\nfirst` },
            { id: 8, body: `${attachmentsMarker("acme")}\nduplicate` },
          ]),
          { status: 200 },
        );
      }
      if (init.method === "DELETE") {
        deleted.push(url);
        return new Response(null, { status: 204 });
      }
      if (url.includes("/issues/comments/7") && init.method === "PATCH") {
        return new Response(
          JSON.stringify({ id: 7, html_url: "https://github.com/acme/web/pull/12#c7" }),
          { status: 200 },
        );
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "BODY",
      "acme",
      fetchImpl,
    );
    expect(res).toEqual({
      action: "updated",
      commentUrl: "https://github.com/acme/web/pull/12#c7",
    });
    expect(deleted).toEqual(["https://api.github.com/repos/acme/web/issues/comments/8"]);
    expect(await kv.get("ghcomment:acme:acme/web#12")).toBe("7");
  });

  it("collects duplicates across pages, keeping the oldest", async () => {
    const { env, kv } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    const fullPage = [
      { id: 7, body: `${attachmentsMarker("acme")}\nfirst` },
      ...Array.from({ length: 99 }, (_, i) => ({ id: 100 + i, body: "noise" })),
    ];
    const deleted: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "t" }), { status: 201 });
      }
      if (url.includes("&page=1")) return new Response(JSON.stringify(fullPage), { status: 200 });
      if (url.includes("&page=2")) {
        return new Response(
          JSON.stringify([{ id: 900, body: `${attachmentsMarker("acme")}\nduplicate` }]),
          { status: 200 },
        );
      }
      if (init.method === "DELETE") {
        deleted.push(url);
        return new Response(null, { status: 204 });
      }
      if (url.includes("/issues/comments/7") && init.method === "PATCH") {
        return new Response(
          JSON.stringify({ id: 7, html_url: "https://github.com/acme/web/pull/12#c7" }),
          { status: 200 },
        );
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "BODY",
      "acme",
      fetchImpl,
    );
    expect(res).toEqual({
      action: "updated",
      commentUrl: "https://github.com/acme/web/pull/12#c7",
    });
    expect(deleted).toEqual(["https://api.github.com/repos/acme/web/issues/comments/900"]);
    expect(await kv.get("ghcomment:acme:acme/web#12")).toBe("7");
  });

  it("still reports updated when deleting a duplicate fails", async () => {
    const { env } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "t" }), { status: 201 });
      }
      if (url.includes("/issues/12/comments")) {
        return new Response(
          JSON.stringify([
            { id: 7, body: `${attachmentsMarker("acme")}\nfirst` },
            { id: 8, body: `${attachmentsMarker("acme")}\nduplicate` },
          ]),
          { status: 200 },
        );
      }
      if (init.method === "DELETE") return new Response("no", { status: 403 });
      if (url.includes("/issues/comments/7") && init.method === "PATCH") {
        return new Response(
          JSON.stringify({ id: 7, html_url: "https://github.com/acme/web/pull/12#c7" }),
          { status: 200 },
        );
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "BODY",
      "acme",
      fetchImpl,
    );
    expect(res).toEqual({
      action: "updated",
      commentUrl: "https://github.com/acme/web/pull/12#c7",
    });
  });

  it("never deletes another workspace's legacy marker comment while deduping", async () => {
    const { env } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      if (url.includes("/access_tokens")) {
        return new Response(JSON.stringify({ token: "t" }), { status: 201 });
      }
      if (url.includes("/issues/12/comments")) {
        return new Response(
          JSON.stringify([
            { id: 1, body: `${ATTACHMENTS_MARKER}\nsomeone else's legacy comment` },
            { id: 7, body: `${attachmentsMarker("acme")}\nours` },
            { id: 8, body: `${attachmentsMarker("acme")}\nour duplicate` },
          ]),
          { status: 200 },
        );
      }
      if (init.method === "DELETE") {
        if (url.includes("/issues/comments/1")) throw new Error("deleted a legacy comment");
        return new Response(null, { status: 204 });
      }
      if (url.includes("/issues/comments/7") && init.method === "PATCH") {
        return new Response(
          JSON.stringify({ id: 7, html_url: "https://github.com/acme/web/pull/12#c7" }),
          { status: 200 },
        );
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "BODY",
      "acme",
      fetchImpl,
    );
    expect(res).toEqual({
      action: "updated",
      commentUrl: "https://github.com/acme/web/pull/12#c7",
    });
  });

  it("patches an existing comment to empty when createIfMissing is false", async () => {
    const { env } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    const fetchImpl = fakeFetch({
      "/access_tokens": () => new Response(JSON.stringify({ token: "t" }), { status: 201 }),
      "/issues/12/comments": (init) => {
        if (init.method === "POST") throw new Error("must not create");
        return new Response(
          JSON.stringify([{ id: 99, body: `${attachmentsMarker("acme")}\nold body` }]),
          { status: 200 },
        );
      },
      "/issues/comments/99": () =>
        new Response(
          JSON.stringify({ id: 99, html_url: "https://github.com/acme/web/pull/12#c99" }),
          { status: 200 },
        ),
    });
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "EMPTY BODY",
      "acme",
      fetchImpl,
      { createIfMissing: false },
    );
    expect(res).toEqual({
      action: "updated",
      commentUrl: "https://github.com/acme/web/pull/12#c99",
    });
  });

  it("no-ops (skipped) when createIfMissing is false and no comment exists", async () => {
    const { env } = makeTestEnv();
    const cfg = { appId: "1", privateKey: await testPem(), homeInstallationId: "9" };
    const fetchImpl = fakeFetch({
      "/access_tokens": () => new Response(JSON.stringify({ token: "t" }), { status: 201 }),
      "/issues/12/comments": (init) => {
        if (init.method === "POST") throw new Error("must not create");
        return new Response(JSON.stringify([]), { status: 200 });
      },
    });
    const res = await upsertBotComment(
      env,
      cfg,
      42,
      { repo: "acme/web", num: 12 },
      "EMPTY BODY",
      "acme",
      fetchImpl,
      { createIfMissing: false },
    );
    expect(res).toEqual({ action: "skipped" });
  });
});
