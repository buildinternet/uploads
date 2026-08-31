// One-off live smoke of the "s3" provider against R2's S3-compatible endpoint.
// Gated on UPLOADS_TEST_R2_* env; not committed — run manually, then delete.
import { describe, expect, it } from "vitest";
import { createStorage } from "../src/index.js";

const env =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const accessKeyId = env.UPLOADS_TEST_R2_ACCESS_KEY_ID;
const secretAccessKey = env.UPLOADS_TEST_R2_SECRET_ACCESS_KEY;
const run = accessKeyId && secretAccessKey ? describe : describe.skip;

const awsAccessKeyId = env.UPLOADS_TEST_S3_ACCESS_KEY_ID;
const awsSecretAccessKey = env.UPLOADS_TEST_S3_SECRET_ACCESS_KEY;
const awsBucket = env.UPLOADS_TEST_S3_BUCKET;
const awsEndpoint = env.UPLOADS_TEST_S3_ENDPOINT ?? "https://s3.us-east-1.amazonaws.com";
const awsRegion =
  env.UPLOADS_TEST_S3_REGION ??
  /s3[.-]([a-z0-9-]+)\.amazonaws\.com/.exec(awsEndpoint)?.[1] ??
  "us-east-1";
const runAws = awsAccessKeyId && awsSecretAccessKey && awsBucket ? describe : describe.skip;

runAws("live s3 smoke vs real AWS (strict region-scoped signing)", () => {
  it("upload → head → download → list → delete round-trip", async () => {
    const files = createStorage({
      provider: "s3",
      bucket: awsBucket as string,
      prefix: "s3-smoke/",
      endpoint: awsEndpoint,
      region: awsRegion,
      forcePathStyle: false,
      accessKeyId: awsAccessKeyId as string,
      secretAccessKey: awsSecretAccessKey as string,
    });

    const key = `live-${Date.now()}.txt`;
    const body = `s3 smoke ${new Date().toISOString()}`;

    await files.upload(key, new TextEncoder().encode(body), { contentType: "text/plain" });

    const head = await files.head(key);
    expect(head.size).toBe(body.length);

    const dl = await files.download(key);
    expect(await dl.text()).toBe(body);

    const listed = await files.list();
    expect(listed.items.map((f) => f.key)).toContain(key);

    await files.delete(key);
    expect(await files.exists(key)).toBe(false);
  }, 30_000);
});

run("live s3 smoke vs R2 S3 endpoint", () => {
  it("upload → head → download → list → delete round-trip", async () => {
    const files = createStorage({
      provider: "s3",
      bucket: "uploads-scratch",
      prefix: "s3-smoke/",
      endpoint: "https://b082600d280d44fd5da3501bc1bffe2f.r2.cloudflarestorage.com",
      region: "auto",
      forcePathStyle: true,
      accessKeyId: accessKeyId as string,
      secretAccessKey: secretAccessKey as string,
    });

    const key = `live-${Date.now()}.txt`;
    const body = `s3 smoke ${new Date().toISOString()}`;

    await files.upload(key, new TextEncoder().encode(body), { contentType: "text/plain" });

    const head = await files.head(key);
    expect(head.size).toBe(body.length);

    const dl = await files.download(key);
    expect(await dl.text()).toBe(body);

    const listed = await files.list();
    expect(listed.items.map((f) => f.key)).toContain(key);

    await files.delete(key);
    expect(await files.exists(key)).toBe(false);
  }, 30_000);
});
