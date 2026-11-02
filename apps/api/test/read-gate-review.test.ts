import { describe, expect, it } from "vitest";
import { FakeR2Bucket } from "./fake-r2";
import { REVIEW_URL_TTL_SECONDS, reviewToken, reviewUrlsFor } from "../src/read-gate";
import type { WorkspaceRecord } from "../src/workspace";

const RECORD = {
  provider: "r2",
  bucket: "uploads-default",
  binding: "UPLOADS_DEFAULT",
  prefix: "acme/",
  publicBaseUrl: "https://storage.uploads.sh",
  tokenHash: "x",
} as WorkspaceRecord;

async function hostedEnv(secret?: string) {
  const bucket = new FakeR2Bucket();
  await bucket.put("acme/shots/a b.png", new Uint8Array([1]).buffer);
  return { UPLOADS_DEFAULT: bucket, READ_GATE_REVIEW_SECRET: secret } as unknown as Env;
}

describe("reviewUrlsFor", () => {
  it("signs the public object key with a 10-minute expiry", async () => {
    const now = 1_800_000_000_000;
    const urls = await reviewUrlsFor(
      await hostedEnv("s3cret"),
      RECORD,
      ["shots/a b.png", "shots/gone.png"],
      now,
    );
    const expiry = now / 1000 + REVIEW_URL_TTL_SECONDS;
    const token = await reviewToken("s3cret", "acme/shots/a b.png", expiry);
    expect([...urls]).toEqual([
      ["shots/a b.png", `https://storage.uploads.sh/acme/shots/a%20b.png?review=${token}`],
    ]);
  });

  it("mints nothing without the secret or on a BYO lane", async () => {
    expect((await reviewUrlsFor(await hostedEnv(), RECORD, ["shots/a b.png"])).size).toBe(0);
    const byo = {
      ...RECORD,
      provider: "s3",
      binding: undefined,
      publicBaseUrl: "https://cdn.example.com",
    } as unknown as WorkspaceRecord;
    expect((await reviewUrlsFor(await hostedEnv("s3cret"), byo, ["shots/a b.png"])).size).toBe(0);
  });

  it("matches the gate's signature for the same inputs", async () => {
    // Same vector as apps/read-gate/src/review.test.ts.
    expect(await reviewToken("test-review-secret", "acme/env.png", 2000000000)).toBe(GATE_VECTOR);
  });
});

const GATE_VECTOR = "2000000000.vsAVaBdd36gpC1-CnmloBXYD4t8j1RUqeOOZ8Zx8JdA";
