import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleWebhook, verifySignature } from "./github-webhook";
import { FakeKv } from "../test/fake-kv";

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
});
