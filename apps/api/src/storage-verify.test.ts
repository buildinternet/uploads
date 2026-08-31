import { describe, expect, it, vi } from "vitest";
import {
  defaultStorageClientFactory,
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

  it("rejects non-public hosts (localhost, IP literals, single-label names) before any probe I/O", async () => {
    for (const publicBaseUrl of [
      "https://localhost",
      "https://media.localhost",
      "https://10.0.0.1",
      "https://[::1]",
      "https://intranet",
    ]) {
      const client = new FakeStorageClient();
      const listSpy = vi.spyOn(client, "list");
      const result = await run({ ...VALID, publicBaseUrl }, client);
      expect(result.ok).toBe(false);
      expect(result.checks[0].hint).toMatch(/public custom domain/);
      // Shape short-circuits — nothing touches the bucket or the URL.
      expect(listSpy).not.toHaveBeenCalled();
    }
  });

  it("rejects an invalid jurisdiction before any client is built", async () => {
    const candidate = { ...VALID, jurisdiction: "us" };
    const createClient = vi.fn(() => new FakeStorageClient());
    const result = await verifyStorageConfig(candidate, { createClient });
    expect(result.ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/jurisdiction must be one of: eu, fedramp/);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("passes shape with a valid jurisdiction and forwards it to the client factory", async () => {
    const candidate = { ...VALID, jurisdiction: "eu" };
    const createClient = vi.fn(() => new FakeStorageClient());
    const result = await verifyStorageConfig(candidate, { createClient });
    const shape = result.checks.find((c) => c.id === "shape")!;
    expect(shape.ok).toBe(true);
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ jurisdiction: "eu" }));
  });

  it("defaultStorageClientFactory re-guards jurisdiction for direct callers", () => {
    expect(() => defaultStorageClientFactory({ ...VALID, jurisdiction: "us" })).toThrow(
      /invalid jurisdiction/,
    );
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
  it("passes end to end on an empty bucket with no publicBaseUrl, flagging signed-only as a warning", async () => {
    const client = new FakeStorageClient();
    const result = await run(VALID, client);
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.id)).toEqual([
      "shape",
      "auth",
      "round-trip",
      "not-empty",
      "public-url",
    ]);
    // Every *required* check passed; the trailing public-url entry is a
    // recommended warning (no publicBaseUrl configured) and doesn't gate ok.
    const publicUrl = result.checks.find((c) => c.id === "public-url")!;
    expect(publicUrl.ok).toBe(false);
    expect(publicUrl.required).toBe(false);
    expect(publicUrl.hint).toMatch(/no public base URL/);
    expect(publicUrl.hint).toMatch(/expire after an hour/);
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
    // Plain-language explanation of what attaching a non-empty bucket
    // actually does (issue #783 Part B item 1) — not just what to click.
    expect(notEmpty.hint).toMatch(/nothing gets imported or copied/i);
    expect(notEmpty.hint).toMatch(/becomes this workspace's root/);
    expect(notEmpty.hint).toMatch(/saving now doesn't switch anything/i);
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

describe("verifyStorageConfig — jurisdiction auto-probe", () => {
  it("uses the candidate's own jurisdiction without probing when one is given", async () => {
    const client = new FakeStorageClient();
    const createClient = vi.fn(() => client);
    const result = await verifyStorageConfig({ ...VALID, jurisdiction: "eu" }, { createClient });
    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ jurisdiction: "eu" }));
    expect(result.jurisdiction).toBe("eu");
  });

  it("probes default, then eu, then fedramp — in that order — and records whichever answers", async () => {
    const attempts: (string | undefined)[] = [];
    const createClient = vi.fn((c: StorageVerifyCandidate) => {
      attempts.push(c.jurisdiction);
      const client = new FakeStorageClient();
      // Only the fedramp endpoint "has" this bucket in this scenario.
      if (c.jurisdiction !== "fedramp") client.listError = new FakeError("NotFound", "no bucket");
      return client;
    });
    const result = await verifyStorageConfig(VALID, { createClient });
    expect(attempts).toEqual([undefined, "eu", "fedramp"]);
    expect(result.jurisdiction).toBe("fedramp");
    expect(result.checks.find((c) => c.id === "auth")!.ok).toBe(true);
  });

  it("stops probing at the first jurisdiction that answers (default)", async () => {
    const createClient = vi.fn(() => new FakeStorageClient());
    const result = await verifyStorageConfig(VALID, { createClient });
    expect(createClient).toHaveBeenCalledOnce();
    expect(result.jurisdiction).toBeUndefined();
  });

  it("falls back to the auth-error hint when no jurisdiction answers", async () => {
    const createClient = vi.fn(() => {
      const client = new FakeStorageClient();
      client.listError = new FakeError("Unauthorized", "denied");
      return client;
    });
    const result = await verifyStorageConfig(VALID, { createClient });
    expect(createClient).toHaveBeenCalledTimes(3);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === "auth")!.hint).toMatch(/access key was rejected/);
    expect(result.jurisdiction).toBeUndefined();
  });
});

describe("verifyStorageConfig — recommended public-URL probe", () => {
  it("never fetches when no publicBaseUrl is supplied, and flags signed-only as a warning instead", async () => {
    const client = new FakeStorageClient();
    const fetchImpl = vi.fn();
    const result = await run(VALID, client, fetchImpl as unknown as typeof fetch);
    const publicUrl = result.checks.find((c) => c.id === "public-url");
    expect(publicUrl).toBeDefined();
    expect(publicUrl!.ok).toBe(false);
    expect(publicUrl!.required).toBe(false);
    expect(publicUrl!.hint).toMatch(/no public base URL set/);
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

  it("reports a non-2xx response as a recommended failure carrying the status", async () => {
    const client = new FakeStorageClient();
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const result = await run(
      { ...VALID, publicBaseUrl: "https://media.example.com" },
      client,
      fetchImpl as unknown as typeof fetch,
    );
    const publicUrl = result.checks.find((c) => c.id === "public-url")!;
    expect(publicUrl.ok).toBe(false);
    expect(publicUrl.required).toBe(false);
    expect(publicUrl.hint).toMatch(/HTTP 404/);
    expect(result.ok).toBe(true);
  });

  it("sends the public-URL probe with an abort signal so a stalled domain can't hang verify", async () => {
    const client = new FakeStorageClient();
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(new Uint8Array([9]), { status: 200 });
    });
    await run(
      { ...VALID, publicBaseUrl: "https://media.example.com" },
      client,
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("probes with redirect: 'manual', not 'error' — local workerd throws synchronously on 'error'", async () => {
    const client = new FakeStorageClient();
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(new Uint8Array([9]), { status: 200 });
    });
    await run(
      { ...VALID, publicBaseUrl: "https://media.example.com" },
      client,
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("reports an un-followed redirect (redirect: 'manual' response) as a conclusive, non-inconclusive failure", async () => {
    const client = new FakeStorageClient();
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, { status: 301, headers: { location: "https://other.example.com/" } }),
    );
    const result = await run(
      { ...VALID, publicBaseUrl: "https://media.example.com" },
      client,
      fetchImpl as unknown as typeof fetch,
    );
    const publicUrl = result.checks.find((c) => c.id === "public-url")!;
    expect(publicUrl.ok).toBe(false);
    expect(publicUrl.required).toBe(false);
    expect(publicUrl.inconclusive).toBeUndefined();
    expect(publicUrl.hint).toMatch(/redirected/);
    expect(result.ok).toBe(true);
  });

  it("warns (embed-cache) when the domain serves cacheable headers, without gating ok", async () => {
    const client = new FakeStorageClient();
    const fetchImpl = vi.fn(async () => {
      const [key] = [...client.store.keys()];
      return new Response(client.store.get(key)!, {
        status: 200,
        headers: { "cache-control": "public, max-age=14400" },
      });
    });
    const result = await run(
      { ...VALID, publicBaseUrl: "https://media.example.com" },
      client,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.ok).toBe(true);
    const embedCache = result.checks.find((c) => c.id === "embed-cache")!;
    expect(embedCache.ok).toBe(false);
    expect(embedCache.required).toBe(false);
    expect(embedCache.hint).toMatch(/optional but recommended/);
    expect(embedCache.hint).toMatch(/Transform Rule/);
  });

  it("passes embed-cache when Cache-Control carries no-store/no-cache", async () => {
    const client = new FakeStorageClient();
    const fetchImpl = vi.fn(async () => {
      const [key] = [...client.store.keys()];
      return new Response(client.store.get(key)!, {
        status: 200,
        headers: { "cache-control": "max-age=0, no-cache, no-store, must-revalidate" },
      });
    });
    const result = await run(
      { ...VALID, publicBaseUrl: "https://media.example.com" },
      client,
      fetchImpl as unknown as typeof fetch,
    );
    const embedCache = result.checks.find((c) => c.id === "embed-cache")!;
    expect(embedCache.ok).toBe(true);
    expect(embedCache.hint).toBeUndefined();
  });

  it("omits embed-cache entirely when the domain couldn't be reached", async () => {
    const client = new FakeStorageClient();
    const fetchImpl = vi.fn(async () => {
      throw new Error("network error: ENOTFOUND");
    });
    const result = await run(
      { ...VALID, publicBaseUrl: "https://media.example.com" },
      client,
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.checks.find((c) => c.id === "embed-cache")).toBeUndefined();
  });

  it("reports a thrown fetch (DNS/timeout/subrequest failure) as 'couldn't verify from here', not 'domain is broken'", async () => {
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
    expect(publicUrl.hint).toMatch(/couldn't verify publicBaseUrl from here/);
    expect(publicUrl.hint).not.toMatch(/not connected/);
    expect(publicUrl.hint).toMatch(/known object/);
    expect(result.ok).toBe(true);
  });

  it("marks only the thrown-fetch case inconclusive — conclusive failures (bad status, byte mismatch) stay definite (#853)", async () => {
    const client = new FakeStorageClient();
    const thrown = vi.fn(async () => {
      throw new Error("network error: ENOTFOUND");
    });
    const unreachable = await run(
      { ...VALID, publicBaseUrl: "https://media.example.com" },
      client,
      thrown as unknown as typeof fetch,
    );
    expect(unreachable.checks.find((c) => c.id === "public-url")!.inconclusive).toBe(true);

    const notFound = vi.fn(async () => new Response(null, { status: 404 }));
    const answered = await run(
      { ...VALID, publicBaseUrl: "https://media.example.com" },
      new FakeStorageClient(),
      notFound as unknown as typeof fetch,
    );
    expect(answered.checks.find((c) => c.id === "public-url")!.inconclusive).toBeUndefined();

    const wrongBytes = vi.fn(async () => new Response(new Uint8Array([9, 9, 9]), { status: 200 }));
    const mismatch = await run(
      { ...VALID, publicBaseUrl: "https://media.example.com" },
      new FakeStorageClient(),
      wrongBytes as unknown as typeof fetch,
    );
    expect(mismatch.checks.find((c) => c.id === "public-url")!.inconclusive).toBeUndefined();
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

const VALID_S3: StorageVerifyCandidate = {
  provider: "s3",
  bucket: "my.bucket",
  endpoint: "https://s3.us-east-1.amazonaws.com",
  region: "us-east-1",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "s3cr3t",
};

describe("verifyStorageConfig — s3 candidates", () => {
  it("passes shape/auth/round-trip for a valid s3 candidate with a single client attempt and no jurisdiction", async () => {
    const client = new FakeStorageClient();
    const createClient = vi.fn(() => client);
    const result = await verifyStorageConfig(VALID_S3, { createClient });
    expect(result.ok).toBe(true);
    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining(VALID_S3));
    expect(result.jurisdiction).toBeUndefined();
  });

  it("fails shape when region is missing", async () => {
    const { region, ...withoutRegion } = VALID_S3;
    const createClient = vi.fn(() => new FakeStorageClient());
    const result = await verifyStorageConfig(withoutRegion, { createClient });
    expect(result.ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/region/);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("fails shape when the endpoint has a path", async () => {
    const result = await verifyStorageConfig(
      { ...VALID_S3, endpoint: "https://s3.amazonaws.com/foo" },
      { createClient: () => new FakeStorageClient() },
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/endpoint/);
  });

  it("fails shape when the endpoint is http", async () => {
    const result = await verifyStorageConfig(
      { ...VALID_S3, endpoint: "http://s3.amazonaws.com" },
      { createClient: () => new FakeStorageClient() },
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/https/);
  });

  it("fails shape when the endpoint host is an internal IP (169.254.169.254)", async () => {
    const result = await verifyStorageConfig(
      { ...VALID_S3, endpoint: "https://169.254.169.254" },
      { createClient: () => new FakeStorageClient() },
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/endpoint/);
  });

  it("fails shape when the endpoint host is an internal IP with a trailing dot (169.254.169.254.)", async () => {
    const result = await verifyStorageConfig(
      { ...VALID_S3, endpoint: "https://169.254.169.254." },
      { createClient: () => new FakeStorageClient() },
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/endpoint/);
  });

  it("fails shape when the endpoint host is a hex-encoded internal IP (0x7f.0x0.0x0.0x1)", async () => {
    const result = await verifyStorageConfig(
      { ...VALID_S3, endpoint: "https://0x7f.0x0.0x0.0x1" },
      { createClient: () => new FakeStorageClient() },
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/endpoint/);
  });

  it("fails shape when the endpoint host is an octal-encoded internal IP (0177.0.0.1)", async () => {
    const result = await verifyStorageConfig(
      { ...VALID_S3, endpoint: "https://0177.0.0.1" },
      { createClient: () => new FakeStorageClient() },
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/endpoint/);
  });

  it("fails shape when the endpoint host is a single-integer IP literal (2130706433)", async () => {
    const result = await verifyStorageConfig(
      { ...VALID_S3, endpoint: "https://2130706433" },
      { createClient: () => new FakeStorageClient() },
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/endpoint/);
  });

  // A trailing dot on an otherwise-legit hostname is normalized away rather
  // than rejected — "example.com." and "example.com" mean the same host.
  it("passes shape for a legit hostname with a trailing dot (example.com.)", async () => {
    const result = await verifyStorageConfig(
      { ...VALID_S3, endpoint: "https://example.com." },
      { createClient: () => new FakeStorageClient() },
    );
    expect(result.checks.find((c) => c.id === "shape")!.ok).toBe(true);
  });

  it("fails shape when the endpoint host is localhost", async () => {
    const result = await verifyStorageConfig(
      { ...VALID_S3, endpoint: "https://localhost" },
      { createClient: () => new FakeStorageClient() },
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/endpoint/);
  });

  it("fails shape for an invalid s3 bucket name", async () => {
    const result = await verifyStorageConfig(
      { ...VALID_S3, bucket: "-bad-" },
      { createClient: () => new FakeStorageClient() },
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/bucket/);
  });

  it("allows dots in the s3 bucket name", async () => {
    const client = new FakeStorageClient();
    const result = await verifyStorageConfig(
      { ...VALID_S3, bucket: "my.bucket.name" },
      { createClient: () => client },
    );
    expect(result.checks.find((c) => c.id === "shape")!.ok).toBe(true);
  });

  it("still rejects dots in an r2 bucket name", async () => {
    const result = await verifyStorageConfig(
      { bucket: "my.bucket", accountId: "a".repeat(32), accessKeyId: "x", secretAccessKey: "y" },
      { createClient: () => new FakeStorageClient() },
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0].hint).toMatch(/bucket name/);
  });

  it("passes shape with region 'auto'", async () => {
    const client = new FakeStorageClient();
    const result = await verifyStorageConfig(
      { ...VALID_S3, region: "auto" },
      { createClient: () => client },
    );
    expect(result.checks.find((c) => c.id === "shape")!.ok).toBe(true);
  });

  it("runs public-url and embed-cache identically for s3", async () => {
    const client = new FakeStorageClient();
    const fetchImpl = vi.fn(async () => {
      const [key] = [...client.store.keys()];
      return new Response(client.store.get(key)!, {
        status: 200,
        headers: { "cache-control": "max-age=0, no-cache, no-store, must-revalidate" },
      });
    });
    const result = await verifyStorageConfig(
      { ...VALID_S3, publicBaseUrl: "https://media.example.com" },
      { createClient: () => client, fetch: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.id === "public-url")!.ok).toBe(true);
    expect(result.checks.find((c) => c.id === "embed-cache")!.ok).toBe(true);
  });

  it("uses the s3-specific auth-hint copy referencing an access key scoped to this bucket", async () => {
    const client = new FakeStorageClient();
    client.listError = new FakeError("Unauthorized", "denied");
    const result = await verifyStorageConfig(VALID_S3, { createClient: () => client });
    const auth = result.checks.find((c) => c.id === "auth")!;
    expect(auth.hint).toMatch(/an access key scoped to this bucket/);
    expect(auth.hint).not.toMatch(/R2 API token/);
  });

  it("defaultStorageClientFactory builds an s3 createStorage config", () => {
    const client = defaultStorageClientFactory(VALID_S3);
    expect(client).toBeDefined();
  });

  it("uses s3-specific round-trip write-rejection copy, not R2 API token wording", async () => {
    const client = new FakeStorageClient();
    client.uploadError = new FakeError("Unauthorized", "read-only key");
    const result = await verifyStorageConfig(VALID_S3, { createClient: () => client });
    const roundTrip = result.checks.find((c) => c.id === "round-trip")!;
    expect(roundTrip.ok).toBe(false);
    expect(roundTrip.hint).toMatch(/the access key needs write permissions/);
    expect(roundTrip.hint).not.toMatch(/R2 API token/);
  });

  it("keeps the r2 round-trip write-rejection copy referencing the R2 API token unchanged", async () => {
    const client = new FakeStorageClient();
    client.uploadError = new FakeError("Unauthorized", "read-only token");
    const result = await run(VALID, client);
    const roundTrip = result.checks.find((c) => c.id === "round-trip")!;
    expect(roundTrip.ok).toBe(false);
    expect(roundTrip.hint).toMatch(/the R2 API token needs Object Read & Write, not read-only/);
  });
});
