import { describe, expect, it } from "vitest";
import type { R2Bucket } from "@cloudflare/workers-types";
import { createStorage, publicUrl, signedDownloadUrl, type StorageConfig } from "../src/index.js";
import { FakeR2Bucket } from "./fake-r2.js";

const base: StorageConfig = {
  provider: "r2",
  bucket: "shared",
  accountId: "acct",
  accessKeyId: "key",
  secretAccessKey: "secret",
};

describe("createStorage prefix", () => {
  it("applies the prefix to the Files instance (normalized, no trailing slash)", () => {
    const files = createStorage({ ...base, prefix: "myws/" });
    expect(files.prefix).toBe("myws");
  });

  it("has no prefix when the config omits it (BYO mode)", () => {
    const files = createStorage(base);
    expect(files.prefix).toBe("");
  });

  it.each(["/myws/", "myws", "a//b/", "../x/", "./", "MyWS/", " /"])(
    "rejects invalid prefix %j",
    (prefix) => {
      expect(() => createStorage({ ...base, prefix })).toThrow(/invalid storage prefix/);
    },
  );

  it("accepts multi-segment prefixes", () => {
    const files = createStorage({ ...base, prefix: "team/myws/" });
    expect(files.prefix).toBe("team/myws");
  });
});

describe("publicUrl", () => {
  const cfg: StorageConfig = { ...base, publicBaseUrl: "https://storage.uploads.sh" };

  it("includes the prefix in the public URL", () => {
    expect(publicUrl({ ...cfg, prefix: "myws/" }, "dir/a.png")).toBe(
      "https://storage.uploads.sh/myws/dir/a.png",
    );
  });

  it("omits the prefix when not configured (BYO mode)", () => {
    expect(publicUrl(cfg, "dir/a.png")).toBe("https://storage.uploads.sh/dir/a.png");
  });

  it("URI-encodes key segments but not the slashes", () => {
    expect(publicUrl({ ...cfg, prefix: "myws/" }, "dir/a b.png")).toBe(
      "https://storage.uploads.sh/myws/dir/a%20b.png",
    );
  });

  it("returns null without a publicBaseUrl", () => {
    expect(publicUrl({ ...base, prefix: "myws/" }, "a.png")).toBeNull();
  });
});

describe("signedDownloadUrl", () => {
  it("returns a presigned URL when the adapter can sign (HTTP mode)", async () => {
    const files = createStorage(base);
    const url = await signedDownloadUrl(files, "a.png");
    expect(url).toMatch(/^https:\/\/acct\.r2\.cloudflarestorage\.com\/shared\/a\.png\?/);
  });

  it("forces an attachment Content-Disposition on the signed URL", async () => {
    const files = createStorage(base);
    const url = await signedDownloadUrl(files, "a.png");
    expect(url).toContain("response-content-disposition=attachment");
  });

  it("honors a custom expiresIn", async () => {
    const files = createStorage(base);
    const url = await signedDownloadUrl(files, "a.png", { expiresIn: 60 });
    expect(url).toContain("X-Amz-Expires=60");
  });

  it("returns null for a binding-only R2 workspace with no signing credentials", async () => {
    const files = createStorage({
      provider: "r2",
      bucket: "shared",
      r2Binding: new FakeR2Bucket() as unknown as R2Bucket,
      prefix: "acme/",
    });
    await expect(signedDownloadUrl(files, "a.png")).resolves.toBeNull();
  });

  it("signs through a binding workspace when hybrid HTTP credentials are also configured", async () => {
    const files = createStorage({
      ...base,
      r2Binding: new FakeR2Bucket() as unknown as R2Bucket,
      prefix: "acme/",
    });
    const url = await signedDownloadUrl(files, "a.png");
    expect(url).toMatch(/^https:\/\/acct\.r2\.cloudflarestorage\.com\/shared\/acme\/a\.png\?/);
  });
});
