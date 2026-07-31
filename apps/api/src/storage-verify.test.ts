import { describe, expect, it, vi } from "vitest";
import {
  type StorageProbeClient,
  type StorageVerifyCandidate,
  verifyStorageConfig,
} from "./storage-verify";

const VALID: StorageVerifyCandidate = {
  bucket: "my-bucket",
  accountId: "a".repeat(32),
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "s3cr3t",
};

class FakeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** In-memory fake standing in for the files-sdk `Files` client the pipeline talks to. */
class FakeStorageClient implements StorageProbeClient {
  store = new Map<string, Uint8Array>();
  deletedKeys: string[] = [];
  listError?: unknown;
  uploadError?: unknown;

  constructor(seed: Record<string, Uint8Array> = {}) {
    for (const [k, v] of Object.entries(seed)) this.store.set(k, v);
  }

  async list(opts?: { prefix?: string; limit?: number }) {
    if (this.listError) throw this.listError;
    const prefix = opts?.prefix ?? "";
    return {
      items: [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
    };
  }

  async upload(key: string, body: Uint8Array) {
    if (this.uploadError) throw this.uploadError;
    this.store.set(key, body);
    return { key, size: body.byteLength, contentType: "application/octet-stream" };
  }

  async download(key: string) {
    const data = this.store.get(key);
    if (!data) throw new FakeError("NotFound", `no such key: ${key}`);
    return {
      arrayBuffer: async () =>
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    };
  }

  async delete(key: string) {
    this.deletedKeys.push(key);
    this.store.delete(key);
  }
}

function run(
  candidate: StorageVerifyCandidate,
  client: FakeStorageClient,
  fetchImpl?: typeof fetch,
) {
  return verifyStorageConfig(candidate, { createClient: () => client, fetch: fetchImpl });
}

describe("verifyStorageConfig — shape", () => {
  it("fails on a malformed account id", async () => {
    const result = await run({ ...VALID, accountId: "not-hex" }, new FakeStorageClient());
    expect(result.ok).toBe(false);
    const shape = result.checks.find((c) => c.id === "shape")!;
    expect(shape.ok).toBe(false);
    expect(shape.required).toBe(true);
    expect(shape.hint).toMatch(/accountId/);
    // Shape failure short-circuits — no further checks run.
    expect(result.checks).toHaveLength(1);
  });

  it("fails on an invalid bucket name", async () => {
    const result = await run({ ...VALID, bucket: "-bad-" }, new FakeStorageClient());
    expect(result.ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/bucket name/);
  });

  it("fails on missing key material", async () => {
    const result = await run(
      { ...VALID, accessKeyId: "", secretAccessKey: "" },
      new FakeStorageClient(),
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/access key id and secret access key/);
  });

  it("rejects a non-https publicBaseUrl", async () => {
    const result = await run(
      { ...VALID, publicBaseUrl: "http://media.example.com" },
      new FakeStorageClient(),
    );
    expect(result.checks[0].hint).toMatch(/https/);
  });

  it("rejects r2.dev with the dedicated 'not supported right now' hint", async () => {
    const result = await run(
      { ...VALID, publicBaseUrl: "https://pub-abc123.r2.dev" },
      new FakeStorageClient(),
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/r2\.dev URLs aren't supported right now/);
  });

  it("rejects an uploads.sh publicBaseUrl", async () => {
    const result = await run(
      { ...VALID, publicBaseUrl: "https://storage.uploads.sh" },
      new FakeStorageClient(),
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/uploads\.sh/);
  });
});

describe("verifyStorageConfig — auth/reachability", () => {
  it("fails with an unauthorized hint on a rejected key", async () => {
    const client = new FakeStorageClient();
    client.listError = new FakeError("Unauthorized", "denied");
    const result = await run(VALID, client);
    expect(result.ok).toBe(false);
    const auth = result.checks.find((c) => c.id === "auth")!;
    expect(auth.ok).toBe(false);
    expect(auth.hint).toMatch(/access key was rejected/);
    // Short-circuits before round-trip/not-empty.
    expect(result.checks.map((c) => c.id)).toEqual(["shape", "auth"]);
  });

  it("fails with a bucket-not-found hint", async () => {
    const client = new FakeStorageClient();
    client.listError = new FakeError("NotFound", "no such bucket");
    const result = await run(VALID, client);
    expect(result.checks.find((c) => c.id === "auth")!.hint).toMatch(/bucket not found/);
  });
});

describe("verifyStorageConfig — round trip + empty-bucket guard", () => {
  it("passes end to end on an empty bucket with no publicBaseUrl", async () => {
    const client = new FakeStorageClient();
    const result = await run(VALID, client);
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.id)).toEqual(["shape", "auth", "round-trip", "not-empty"]);
    expect(result.checks.every((c) => c.ok)).toBe(true);
    // Probe object must not be left behind.
    expect(client.store.size).toBe(0);
    expect(client.deletedKeys).toHaveLength(1);
    expect(client.deletedKeys[0]).toMatch(/^_internal\/uploads-verify\//);
  });

  it("fails the empty-bucket guard when the bucket already has objects", async () => {
    const client = new FakeStorageClient({ "some/existing.png": new Uint8Array([1, 2, 3]) });
    const result = await run(VALID, client);
    expect(result.ok).toBe(false);
    const notEmpty = result.checks.find((c) => c.id === "not-empty")!;
    expect(notEmpty.ok).toBe(false);
    expect(notEmpty.hint).toMatch(/adoptExistingContents/);
  });

  it("passes the empty-bucket guard when adoptExistingContents is set", async () => {
    const client = new FakeStorageClient({ "some/existing.png": new Uint8Array([1, 2, 3]) });
    const result = await run({ ...VALID, adoptExistingContents: true }, client);
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.id === "not-empty")!.ok).toBe(true);
  });

  it("does not count a leftover probe object from a prior failed run against the empty-bucket guard", async () => {
    const client = new FakeStorageClient({
      "_internal/uploads-verify/stale-uuid": new Uint8Array([9]),
    });
    const result = await run(VALID, client);
    expect(result.checks.find((c) => c.id === "not-empty")!.ok).toBe(true);
  });

  it("cleans up the probe object even when the round-trip fails", async () => {
    const client = new FakeStorageClient();
    client.uploadError = new FakeError("Unauthorized", "read-only token");
    const result = await run(VALID, client);
    const roundTrip = result.checks.find((c) => c.id === "round-trip")!;
    expect(roundTrip.ok).toBe(false);
    expect(roundTrip.hint).toMatch(/Object Read & Write/);
    // delete() is still attempted (best-effort) even though upload failed.
    expect(client.deletedKeys).toHaveLength(1);
    expect(result.ok).toBe(false);
  });

  it("never echoes credential values in any check hint", async () => {
    const client = new FakeStorageClient();
    client.listError = new FakeError("Unauthorized", "denied");
    const result = await run(VALID, client);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(VALID.secretAccessKey);
    expect(serialized).not.toContain(VALID.accessKeyId);
  });
});

describe("verifyStorageConfig — recommended public-URL probe", () => {
  it("skips cleanly when no publicBaseUrl is supplied (signed-only mode)", async () => {
    const client = new FakeStorageClient();
    const fetchImpl = vi.fn();
    const result = await run(VALID, client, fetchImpl as unknown as typeof fetch);
    expect(result.checks.find((c) => c.id === "public-url")).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes as a recommended check when the served bytes match", async () => {
    const client = new FakeStorageClient();
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
      const [key] = client.deletedKeys.length ? client.deletedKeys : [...client.store.keys()];
      const data = client.store.get(key)!;
      return new Response(data, { status: 200 });
    });
    const result = await run(
      { ...VALID, publicBaseUrl: "https://media.example.com" },
      client,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.ok).toBe(true);
    const publicUrl = result.checks.find((c) => c.id === "public-url")!;
    expect(publicUrl.ok).toBe(true);
    expect(publicUrl.required).toBe(false);
  });

  it("marks a byte mismatch as a recommended failure without flipping overall ok", async () => {
    const client = new FakeStorageClient();
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([9, 9, 9]), { status: 200 }));
    const result = await run(
      { ...VALID, publicBaseUrl: "https://media.example.com" },
      client,
      fetchImpl as unknown as typeof fetch,
    );
    const publicUrl = result.checks.find((c) => c.id === "public-url")!;
    expect(publicUrl.ok).toBe(false);
    expect(publicUrl.required).toBe(false);
    expect(publicUrl.hint).toMatch(/cached|stale/);
    // Recommended check never gates ok — required checks all passed.
    expect(result.ok).toBe(true);
  });

  it("reports a fetch failure (DNS/timeout) as a recommended, non-gating failure", async () => {
    const client = new FakeStorageClient();
    const fetchImpl = vi.fn(async () => {
      throw new Error("network error: ENOTFOUND");
    });
    const result = await run(
      { ...VALID, publicBaseUrl: "https://media.example.com" },
      client,
      fetchImpl as unknown as typeof fetch,
    );
    const publicUrl = result.checks.find((c) => c.id === "public-url")!;
    expect(publicUrl.ok).toBe(false);
    expect(publicUrl.hint).toMatch(/DNS/);
    expect(result.ok).toBe(true);
  });

  it("skips the public-url check (marked failed) when the round-trip itself failed", async () => {
    const client = new FakeStorageClient();
    client.uploadError = new FakeError("Unauthorized", "read-only token");
    const fetchImpl = vi.fn();
    const result = await run(
      { ...VALID, publicBaseUrl: "https://media.example.com" },
      client,
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    const publicUrl = result.checks.find((c) => c.id === "public-url")!;
    expect(publicUrl.ok).toBe(false);
    expect(publicUrl.required).toBe(false);
    expect(publicUrl.hint).toMatch(/skipped/);
    expect(result.ok).toBe(false); // round-trip (required) failed
  });
});
