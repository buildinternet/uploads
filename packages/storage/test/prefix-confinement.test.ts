import { describe, expect, it } from "vitest";
import type { R2Bucket } from "@cloudflare/workers-types";
import { createStorage } from "../src/index.js";
import { FakeR2Bucket } from "./fake-r2.js";

/** Two workspaces sharing one bucket, like default-mode tenants in uploads-default. */
function tenant(bucket: FakeR2Bucket, prefix: string) {
  return createStorage({
    provider: "r2",
    bucket: "uploads-default",
    prefix,
    r2Binding: bucket as unknown as R2Bucket,
  });
}

const body = (s: string) => new TextEncoder().encode(s);

describe("prefix confinement through createStorage", () => {
  it("writes land under the workspace prefix in the raw bucket", async () => {
    const bucket = new FakeR2Bucket();
    await tenant(bucket, "alpha/").upload("dir/a.txt", body("hi"), {
      contentType: "text/plain",
    });
    expect([...bucket.store.keys()]).toEqual(["alpha/dir/a.txt"]);
  });

  it("reads see only the workspace's own objects", async () => {
    const bucket = new FakeR2Bucket();
    const alpha = tenant(bucket, "alpha/");
    const beta = tenant(bucket, "beta/");
    await alpha.upload("secret.txt", body("alpha data"), { contentType: "text/plain" });

    expect(await alpha.exists("secret.txt")).toBe(true);
    expect(await beta.exists("secret.txt")).toBe(false);
    // A tenant also can't reach another tenant's data by naming its prefix:
    // that just becomes a key under its OWN prefix (beta/alpha/secret.txt).
    expect(await beta.exists("alpha/secret.txt")).toBe(false);
  });

  it("list returns only own objects, with the prefix stripped", async () => {
    const bucket = new FakeR2Bucket();
    const alpha = tenant(bucket, "alpha/");
    const beta = tenant(bucket, "beta/");
    await alpha.upload("one.txt", body("1"), { contentType: "text/plain" });
    await alpha.upload("dir/two.txt", body("2"), { contentType: "text/plain" });
    await beta.upload("other.txt", body("3"), { contentType: "text/plain" });

    const result = await alpha.list();
    const keys = result.items.map((i: { key: string }) => i.key).sort();
    expect(keys).toEqual(["dir/two.txt", "one.txt"]);
  });

  it("delete only touches the workspace's own prefix", async () => {
    const bucket = new FakeR2Bucket();
    const alpha = tenant(bucket, "alpha/");
    const beta = tenant(bucket, "beta/");
    await alpha.upload("same-name.txt", body("alpha"), { contentType: "text/plain" });
    await beta.upload("same-name.txt", body("beta"), { contentType: "text/plain" });

    await alpha.delete("same-name.txt");

    expect(bucket.store.has("alpha/same-name.txt")).toBe(false);
    expect(bucket.store.has("beta/same-name.txt")).toBe(true);
  });

  it("an unprefixed instance (BYO mode) sees the whole bucket", async () => {
    const bucket = new FakeR2Bucket();
    await tenant(bucket, "alpha/").upload("a.txt", body("a"), { contentType: "text/plain" });
    const byo = createStorage({
      provider: "r2",
      bucket: "uploads-default",
      r2Binding: bucket as unknown as R2Bucket,
    });
    expect(await byo.exists("alpha/a.txt")).toBe(true);
  });
});
