import { describe, expect, it } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import { listObjects } from "../src/files-core";
import type { WorkspaceRecord } from "../src/workspace";

// `Env` is a global ambient type (apps/api/src/env.d.ts) — no import needed.
function makeEnv(bucket: FakeR2Bucket) {
  return { UPLOADS_DEFAULT: bucket, WEB_ORIGIN: "https://uploads.sh" } as unknown as Env;
}

const record: WorkspaceRecord = {
  provider: "r2",
  bucket: "uploads-default",
  binding: "UPLOADS_DEFAULT",
  prefix: "default/",
  publicBaseUrl: "https://storage.uploads.sh",
};

describe("listObjects pageUrl", () => {
  it("emits a /f/ pageUrl for public-url objects when workspaceName is given", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("default/gh/o/r/pull/1/a.png", new Uint8Array([1, 2, 3]));
    const env = makeEnv(bucket);
    const { items } = await listObjects(env, record, {
      prefix: "gh/o/r/pull/1/",
      workspaceName: "acme",
    });
    expect(items[0].pageUrl).toBe("https://uploads.sh/f/acme/gh/o/r/pull/1/a.png");
  });

  it("omits pageUrl when workspaceName is not provided", async () => {
    const bucket = new FakeR2Bucket();
    await bucket.put("default/gh/o/r/pull/1/a.png", new Uint8Array([1, 2, 3]));
    const { items } = await listObjects(makeEnv(bucket), record, { prefix: "gh/o/r/pull/1/" });
    expect(items[0].pageUrl).toBeUndefined();
  });
});
