import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { contentHashForKey } from "../src/content-hash";
import { putObject } from "../src/files-core";
import { makePosterEnv, WORKSPACE } from "./poster-fixtures";

function chunked(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.slice(offset, (offset += chunkSize)));
    },
  });
}

describe("streamed upload content hash", () => {
  it("records the digest in R2 custom metadata and file_content_hash", async () => {
    const { env, bucket, ws } = makePosterEnv();
    const bytes = new Uint8Array(70 * 1024);
    bytes.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const result = await putObject(
      env,
      ws,
      "videos/clip.mp4",
      { stream: chunked(bytes, 8 * 1024), size: bytes.byteLength },
      WORKSPACE,
      { provenance: { client: "uploads-cli" } },
    );

    expect(result.provenance).toMatchObject({ client: "uploads-cli", "content-sha256": hash });
    const stored = bucket.store.get(`default/${result.key}`);
    expect(stored?.data).toEqual(bytes);
    expect(stored?.customMetadata?.["content-sha256"]).toBe(hash);
    expect(stored?.customMetadata?.client).toBe("uploads-cli");
    expect(await contentHashForKey(env.DB, WORKSPACE, result.key)).toBe(hash);
    expect(bucket.listCalls).toBe(0);
  });
});
