import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractWebhookEvent, handleWebhook, verifySignature } from "./github-webhook";
import { githubAppConfig, repoIsPrivate } from "./github-app";
import { FakeKv } from "../test/fake-kv";
import { GITHUB_APP_CFG_ENV } from "../test/github-app-env";

const SECRET = "webhook-secret";
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

function envWith(kv: FakeKv): Env {
  return { GITHUB_CACHE: kv } as unknown as Env;
}

describe("verifySignature", () => {
  it("accepts a correctly signed body", async () => {
    const body = JSON.stringify({ hello: "world" });
    expect(await verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const body = JSON.stringify({ hello: "world" });
    expect(await verifySignature(`${body} `, sign(body), SECRET)).toBe(false);
  });

  it("rejects the wrong secret", async () => {
    const body = "x";
    expect(await verifySignature(body, sign(body), "other-secret")).toBe(false);
  });

  it("rejects a missing or malformed header", async () => {
    expect(await verifySignature("x", null, SECRET)).toBe(false);
    expect(await verifySignature("x", "not-sha256", SECRET)).toBe(false);
  });
});

describe("handleWebhook", () => {
  it("installation created drops the token and each repo's install entry", async () => {
    const kv = new FakeKv();
    kv.store.set("ghtok:42", { value: "t" });
    kv.store.set("ghinst:owner/repo", { value: "42" });
    kv.store.set("ghinst:other/keep", { value: "9" });
    await handleWebhook(envWith(kv), "installation", {
      action: "created",
      installation: { id: 42 },
      repositories: [{ full_name: "Owner/Repo" }],
    });
    expect(kv.store.has("ghtok:42")).toBe(false);
    expect(kv.store.has("ghinst:owner/repo")).toBe(false);
    expect(kv.store.has("ghinst:other/keep")).toBe(true);
  });

  it("installation suspend without a repo list drops only the token", async () => {
    const kv = new FakeKv();
    kv.store.set("ghtok:42", { value: "t" });
    kv.store.set("ghinst:owner/repo", { value: "42" });
    await handleWebhook(envWith(kv), "installation", {
      action: "suspend",
      installation: { id: 42 },
    });
    expect(kv.store.has("ghtok:42")).toBe(false);
    expect(kv.store.has("ghinst:owner/repo")).toBe(true);
  });

  it("installation_repositories drops both added and removed install entries", async () => {
    const kv = new FakeKv();
    kv.store.set("ghinst:o/a", { value: "1" });
    kv.store.set("ghinst:o/b", { value: "1" });
    await handleWebhook(envWith(kv), "installation_repositories", {
      action: "added",
      repositories_added: [{ full_name: "O/A" }],
      repositories_removed: [{ full_name: "O/B" }],
    });
    expect(kv.store.has("ghinst:o/a")).toBe(false);
    expect(kv.store.has("ghinst:o/b")).toBe(false);
  });

  it("issues and pull_request drop the ref cache on any action", async () => {
    const kv = new FakeKv();
    kv.store.set("ghref:owner/repo#7", { value: "{}" });
    kv.store.set("ghref:o/r#3", { value: "{}" });
    await handleWebhook(envWith(kv), "issues", {
      action: "closed",
      repository: { full_name: "Owner/Repo" },
      issue: { number: 7 },
    });
    await handleWebhook(envWith(kv), "pull_request", {
      action: "synchronize",
      repository: { full_name: "O/R" },
      pull_request: { number: 3 },
    });
    expect(kv.store.has("ghref:owner/repo#7")).toBe(false);
    expect(kv.store.has("ghref:o/r#3")).toBe(false);
  });

  it("ignores unknown events and never throws on malformed payloads", async () => {
    const kv = new FakeKv();
    kv.store.set("ghref:o/r#1", { value: "{}" });
    await handleWebhook(envWith(kv), "ping", {});
    await handleWebhook(envWith(kv), "issues", null);
    await handleWebhook(envWith(kv), "issues", {});
    await handleWebhook(envWith(kv), "star", { repository: { full_name: "o/r" } });
    expect(kv.store.has("ghref:o/r#1")).toBe(true);
  });

  it("resolves even when a KV delete rejects", async () => {
    const env = {
      GITHUB_CACHE: {
        delete: async () => {
          throw new Error("kv down");
        },
      },
    } as unknown as Env;
    await expect(
      handleWebhook(env, "issues", {
        action: "edited",
        repository: { full_name: "o/r" },
        issue: { number: 1 },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("handleWebhook — repository.private write-through (issue #631)", () => {
  it("a pull_request payload with private:true populates the KV privacy cache (repoIsPrivate answers without fetch)", async () => {
    const kv = new FakeKv();
    const env = { GITHUB_CACHE: kv, ...GITHUB_APP_CFG_ENV } as unknown as Env;

    await handleWebhook(env, "pull_request", {
      action: "labeled",
      repository: { full_name: "acme/web", private: true },
      pull_request: { number: 3 },
    });

    const cfg = githubAppConfig(env);
    expect(cfg).not.toBeNull();
    // installationId (1) is irrelevant here — the cache hit short-circuits
    // before any installation token is ever needed, so no fetch occurs.
    const result = await repoIsPrivate(env, cfg!, 1, "acme/web");
    expect(result).toBe(true);
  });

  it("a repository.private:false payload caches the negative answer too", async () => {
    const kv = new FakeKv();
    const env = { GITHUB_CACHE: kv, ...GITHUB_APP_CFG_ENV } as unknown as Env;

    await handleWebhook(env, "pull_request", {
      action: "labeled",
      repository: { full_name: "acme/web", private: false },
      pull_request: { number: 3 },
    });

    const cfg = githubAppConfig(env);
    const result = await repoIsPrivate(env, cfg!, 1, "acme/web");
    expect(result).toBe(false);
  });

  it("issue_comment payloads write through the same way as pull_request", async () => {
    const kv = new FakeKv();
    const env = { GITHUB_CACHE: kv, ...GITHUB_APP_CFG_ENV } as unknown as Env;

    await handleWebhook(env, "issue_comment", {
      action: "created",
      repository: { full_name: "acme/private-repo", private: true },
      issue: { number: 1 },
      comment: { id: 1, body: "hello", user: { login: "octocat", type: "User" } },
    });

    const cfg = githubAppConfig(env);
    const result = await repoIsPrivate(env, cfg!, 1, "acme/private-repo");
    expect(result).toBe(true);
  });

  it("extractWebhookEvent omits `privacy` when repository.private is absent or non-boolean", () => {
    expect(
      extractWebhookEvent("pull_request", {
        action: "labeled",
        repository: { full_name: "acme/web" },
        pull_request: { number: 3 },
      })?.privacy,
    ).toBeUndefined();
    expect(
      extractWebhookEvent("pull_request", {
        action: "labeled",
        repository: { full_name: "acme/web", private: "true" },
        pull_request: { number: 3 },
      })?.privacy,
    ).toBeUndefined();
  });

  it("survives a privacy-cache write failure without throwing (degrade-safe, never blocks the rest of the event)", async () => {
    let deleteCalled = false;
    const env = {
      GITHUB_CACHE: {
        put: async () => {
          throw new Error("kv down");
        },
        delete: async () => {
          deleteCalled = true;
        },
      },
    } as unknown as Env;
    await expect(
      handleWebhook(env, "pull_request", {
        action: "labeled",
        repository: { full_name: "acme/web", private: true },
        pull_request: { number: 3 },
      }),
    ).resolves.toBeUndefined();
    expect(deleteCalled).toBe(true);
  });

  it("awaits the privacy write-through rather than firing it off unobserved (no floating promise)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath, URL: NodeURL } = await import("node:url");
    const src = readFileSync(
      fileURLToPath(new NodeURL("./github-webhook.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toMatch(/await cacheRepoPrivacy\(/);
  });
});
