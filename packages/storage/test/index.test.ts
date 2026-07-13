import { describe, expect, it } from "vitest";
import type { R2Bucket } from "@cloudflare/workers-types";
import {
  createStorage,
  embedUrlFromPublic,
  publicAndEmbedUrls,
  publicUrl,
  resolveEmbedBaseUrl,
  signedDownloadUrl,
  type StorageConfig,
} from "../src/index.js";
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

describe("embedUrlFromPublic", () => {
  it("rewrites storage.uploads.sh to embed.uploads.sh by default", () => {
    expect(
      embedUrlFromPublic("https://storage.uploads.sh/default/gh/o/r/pull/1/a.webp", {
        publicBaseUrl: "https://storage.uploads.sh",
      }),
    ).toBe("https://embed.uploads.sh/default/gh/o/r/pull/1/a.webp");
  });

  it("infers publicBaseUrl from a known embeddable host when omitted", () => {
    expect(embedUrlFromPublic("https://storage.uploads.sh/default/a.webp")).toBe(
      "https://embed.uploads.sh/default/a.webp",
    );
  });

  it("rewrites store.uploads.sh twin as well", () => {
    expect(
      embedUrlFromPublic("https://store.uploads.sh/default/a.png", {
        publicBaseUrl: "https://store.uploads.sh",
      }),
    ).toBe("https://embed.uploads.sh/default/a.png");
  });

  it("returns null for BYO public bases without an embed override", () => {
    expect(
      embedUrlFromPublic("https://cdn.example.com/ws/a.png", {
        publicBaseUrl: "https://cdn.example.com",
      }),
    ).toBeNull();
  });

  it("honors an explicit embed base for self-host", () => {
    expect(
      embedUrlFromPublic("https://cdn.example.com/ws/a.png", {
        publicBaseUrl: "https://cdn.example.com",
        embedBaseUrl: "https://embed.example.com",
      }),
    ).toBe("https://embed.example.com/ws/a.png");
  });

  it("disables embed when embedBaseUrl is empty", () => {
    expect(
      embedUrlFromPublic("https://storage.uploads.sh/default/a.png", {
        publicBaseUrl: "https://storage.uploads.sh",
        embedBaseUrl: "",
      }),
    ).toBeNull();
  });

  it("publicAndEmbedUrls pairs both", () => {
    expect(
      publicAndEmbedUrls(
        { ...base, publicBaseUrl: "https://storage.uploads.sh", prefix: "default/" },
        "gh/x.png",
      ),
    ).toEqual({
      url: "https://storage.uploads.sh/default/gh/x.png",
      embedUrl: "https://embed.uploads.sh/default/gh/x.png",
    });
  });

  it("resolveEmbedBaseUrl defaults only for known hosts", () => {
    expect(resolveEmbedBaseUrl("https://storage.uploads.sh")).toBe("https://embed.uploads.sh");
    expect(resolveEmbedBaseUrl("https://cdn.other.com")).toBeNull();
    expect(resolveEmbedBaseUrl("https://cdn.other.com", "https://e.other.com/")).toBe(
      "https://e.other.com",
    );
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
