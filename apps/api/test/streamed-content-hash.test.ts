import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { contentHashForKey } from "../src/content-hash";
import { putObject } from "../src/files-core";
import { getFileMetadata, setServerFileMetadata } from "../src/file-metadata";
import { applyUploadHold } from "../src/upload-hold-service";
import type { WorkspaceRecord } from "../src/workspace";
import { FakeR2Bucket } from "./fake-r2";
import { SqliteD1, database } from "./helpers/sqlite-d1";
import { makePosterEnv, WORKSPACE } from "./poster-fixtures";

const API_ROOT = fileURLToPath(new NodeURL("../", import.meta.url));
const MIGRATIONS = readdirSync(resolve(API_ROOT, "migrations"))
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => `migrations/${name}`);

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
  it("stamps content-sha256 on the object and in file_content_hash", async () => {
    const { env, bucket, db, ws } = makePosterEnv();
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
    expect(stored?.cacheControl).toBe("public, max-age=60");
    expect(await contentHashForKey(env.DB, WORKSPACE, result.key)).toBe(hash);
    expect(db.usage.get(WORKSPACE)?.uploads_in_period).toBe(1);
    expect(db.usage.get(WORKSPACE)?.objects).toBe(1);
    expect(bucket.listCalls).toBe(0);
  });

  it("fans a later hold out to a copy of the same streamed bytes", async () => {
    const sqlite = new SqliteD1(MIGRATIONS);
    const db = database(sqlite);
    const bucket = new FakeR2Bucket();
    const ws: WorkspaceRecord = {
      provider: "r2",
      bucket: "uploads-default",
      binding: "UPLOADS_DEFAULT",
      prefix: "acme/",
      publicBaseUrl: "https://storage.uploads.sh",
    };
    const env = {
      DB: db,
      UPLOADS_DEFAULT: bucket,
      FLAGS: { getBooleanValue: async () => true },
    } as unknown as Env;
    const bytes = new Uint8Array(70 * 1024);
    bytes.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const body = () => ({ stream: chunked(bytes, 8 * 1024), size: bytes.byteLength });

    const source = await putObject(env, ws, "videos/a.mp4", body(), "acme");
    const copy = await putObject(env, ws, "videos/b.mp4", body(), "acme");
    const sha = source.provenance?.["content-sha256"];
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(copy.provenance?.["content-sha256"]).toBe(sha);
    await setServerFileMetadata(db, "acme", copy.key, { "ai.copied-from": source.key });

    expect(
      await applyUploadHold(
        env,
        ws,
        "acme",
        source.key,
        { "ai.secret": "token", "ai.secret.confidence": "high" },
        { enforce: true, contentSha256: sha },
      ),
    ).toBe(true);
    expect((await getFileMetadata(db, "acme", copy.key))["ai.hold"]).toBe("pending");
    expect((await getFileMetadata(db, "acme", source.key))["ai.hold"]).toBe("pending");
    sqlite.close();
  });
});
