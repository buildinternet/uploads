import { describe, expect, it } from "vitest";
import { createStorage, publicUrl, type StorageConfig } from "../src/index.js";

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
