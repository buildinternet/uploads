import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorage, type StorageConfig } from "../src/index.js";

const base: StorageConfig = {
  provider: "s3",
  bucket: "my-bucket",
  region: "us-east-1",
  endpoint: "https://s3.us-east-1.amazonaws.com",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secretExample",
};

describe("createStorage s3 provider", () => {
  it("returns a Files instance whose adapter name is s3-http-fetch", () => {
    const files = createStorage(base);
    expect(files.adapter.name).toBe("s3-http-fetch");
  });
});

describe("createStorage s3 provider HTTP behavior", () => {
  let calls: Request[];

  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        calls.push(request);
        return new Response("", { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a PUT via storage hits the expected virtual-hosted URL and signs with SigV4", async () => {
    const files = createStorage({ ...base, prefix: "ws/" });
    await files.upload("dir/a.txt", new TextEncoder().encode("hi"), {
      contentType: "text/plain",
    });

    expect(calls).toHaveLength(1);
    const request = calls[0]!;
    expect(request.method).toBe("PUT");
    expect(request.url).toBe("https://my-bucket.s3.us-east-1.amazonaws.com/ws/dir/a.txt");
    const auth = request.headers.get("authorization") ?? "";
    expect(auth).toContain("Credential=");
    expect(auth).toContain("/us-east-1/s3/aws4_request");
  });

  it("forcePathStyle produces a path-style URL", async () => {
    const files = createStorage({ ...base, forcePathStyle: true });
    await files.upload("a.txt", new TextEncoder().encode("hi"), {
      contentType: "text/plain",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://s3.us-east-1.amazonaws.com/my-bucket/a.txt");
  });

  it("confines operations under the workspace prefix", async () => {
    const alpha = createStorage({ ...base, prefix: "alpha/" });
    const beta = createStorage({ ...base, prefix: "beta/" });

    await alpha.upload("secret.txt", new TextEncoder().encode("data"), {
      contentType: "text/plain",
    });
    await beta.exists("secret.txt");

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe("https://my-bucket.s3.us-east-1.amazonaws.com/alpha/secret.txt");
    expect(calls[1]!.url).toBe("https://my-bucket.s3.us-east-1.amazonaws.com/beta/secret.txt");
  });
});
