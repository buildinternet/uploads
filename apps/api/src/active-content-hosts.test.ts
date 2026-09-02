import { describe, expect, it, vi } from "vitest";
import {
  HOSTED_ACTIVE_CONTENT_HOSTS,
  hostActiveContentKey,
  probeHostActiveContent,
  readHostActiveContent,
  runActiveContentHostSweep,
} from "./active-content-hosts";
import { FakeR2Bucket } from "../test/fake-r2";

/**
 * `vi.fn`'s inferred call signature never structurally matches the
 * overloaded `typeof fetch`, so every fake is built with an explicit,
 * fetch-compatible signature and handed to the functions under test through
 * this cast rather than fighting TS overload assignability at each call
 * site — the fake's own `.mock.calls` stay precisely typed for assertions.
 */
function asFetch(
  fn: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>,
): typeof fetch {
  return fn as unknown as typeof fetch;
}

/** In-memory REGISTRY KV stand-in — get/put/delete over a Map. */
function fakeRegistry(records: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(records));
  return {
    store,
    get: (async (key: string) => store.get(key) ?? null) as unknown as KVNamespace["get"],
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, JSON.parse(value));
    }) as unknown as KVNamespace["put"],
    delete: (async (key: string) => {
      store.delete(key);
    }) as unknown as KVNamespace["delete"],
  };
}

/**
 * A passing response for whichever probe object the URL names — the probe
 * writes an SVG *and* an XML object (issue #929 adversarial review M-1) and
 * requires the served content type to match each.
 */
function okProbeResponse(url: string): Response {
  return new Response("<probe/>", {
    status: 200,
    headers: {
      "content-type": url.endsWith(".xml") ? "application/xml" : "image/svg+xml",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}

function env(over: Record<string, unknown> = {}) {
  return {
    UPLOADS_DEFAULT: new FakeR2Bucket(),
    REGISTRY: fakeRegistry(),
    ...over,
  } as unknown as Env;
}

describe("hostActiveContentKey", () => {
  it("namespaces the KV key by host", () => {
    expect(hostActiveContentKey("storage.uploads.sh")).toBe(
      "host-active-content:storage.uploads.sh",
    );
  });
});

describe("HOSTED_ACTIVE_CONTENT_HOSTS", () => {
  it("is the deduped hosted host set", () => {
    expect([...new Set(HOSTED_ACTIVE_CONTENT_HOSTS)]).toEqual([...HOSTED_ACTIVE_CONTENT_HOSTS]);
    expect(HOSTED_ACTIVE_CONTENT_HOSTS).toEqual(
      expect.arrayContaining(["storage.uploads.sh", "store.uploads.sh", "embed.uploads.sh"]),
    );
    expect(HOSTED_ACTIVE_CONTENT_HOSTS.length).toBe(3);
  });
});

describe("probeHostActiveContent", () => {
  it("writes the probe object, deletes it, and records ok:true on a passing host", async () => {
    const bucket = new FakeR2Bucket();
    const registry = fakeRegistry();
    const e = env({ UPLOADS_DEFAULT: bucket, REGISTRY: registry });
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) =>
      okProbeResponse(url),
    );

    const record = await probeHostActiveContent(e, "storage.uploads.sh", asFetch(fetchImpl));

    expect(record.ok).toBe(true);
    expect(typeof record.verifiedAt).toBe("string");
    expect(Number.isFinite(Date.parse(record.verifiedAt))).toBe(true);

    // Two objects written under the shared verify-probe prefix — one SVG,
    // one XML, sharing a stem — each fetched back, then both deleted
    // (finally) once the probe resolved.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const fetchedUrls = fetchImpl.mock.calls.map((call) => call[0]);
    expect(fetchedUrls[0]).toMatch(
      /^https:\/\/storage\.uploads\.sh\/_internal\/uploads-verify\/[0-9a-f-]+\.svg$/,
    );
    expect(fetchedUrls[1]).toMatch(
      /^https:\/\/storage\.uploads\.sh\/_internal\/uploads-verify\/[0-9a-f-]+\.xml$/,
    );
    expect(fetchedUrls[0]?.replace(/\.svg$/, "")).toBe(fetchedUrls[1]?.replace(/\.xml$/, ""));
    expect(bucket.store.size).toBe(0);

    // KV host record persisted under the namespaced key.
    expect(registry.put).toHaveBeenCalledTimes(1);
    expect(registry.store.get("host-active-content:storage.uploads.sh")).toEqual(record);
  });

  it("still writes an object and deletes it, and records ok:false with a detail, on a failing probe", async () => {
    const bucket = new FakeR2Bucket();
    const registry = fakeRegistry();
    const e = env({ UPLOADS_DEFAULT: bucket, REGISTRY: registry });
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response("<svg/>", { status: 200, headers: { "content-type": "text/plain" } }),
    );

    const record = await probeHostActiveContent(e, "store.uploads.sh", asFetch(fetchImpl));

    expect(record.ok).toBe(false);
    expect(record.detail).toBeTruthy();
    expect(bucket.store.size).toBe(0);
    expect(registry.store.get("host-active-content:store.uploads.sh")).toEqual(record);
  });

  it("records ok:false when the host sandboxes SVG but not XML (issue #929 M-1)", async () => {
    const bucket = new FakeR2Bucket();
    const registry = fakeRegistry();
    const e = env({ UPLOADS_DEFAULT: bucket, REGISTRY: registry });
    // An extension-scoped Transform Rule (`ends_with ".svg"`) looks exactly
    // like this from outside: the SVG probe passes, the XML one comes back
    // bare. One passing probe must not open all three gated types.
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) =>
      url.endsWith(".xml")
        ? new Response("<probe/>", {
            status: 200,
            headers: { "content-type": "application/xml" },
          })
        : okProbeResponse(url),
    );

    const record = await probeHostActiveContent(e, "storage.uploads.sh", asFetch(fetchImpl));

    expect(record.ok).toBe(false);
    expect(record.detail).toContain("application/xml probe");
    expect(bucket.store.size).toBe(0);
  });

  it("records ok:false when the fetch throws (inconclusive)", async () => {
    const bucket = new FakeR2Bucket();
    const registry = fakeRegistry();
    const e = env({ UPLOADS_DEFAULT: bucket, REGISTRY: registry });
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => {
      throw new Error("network unreachable");
    });

    const record = await probeHostActiveContent(e, "embed.uploads.sh", asFetch(fetchImpl));

    expect(record.ok).toBe(false);
    expect(bucket.store.size).toBe(0);
    expect(registry.store.get("host-active-content:embed.uploads.sh")).toEqual(record);
  });

  it("records a failure without ever reaching the fetch when the R2 put itself throws", async () => {
    const bucket = new FakeR2Bucket();
    bucket.put = vi.fn(async () => {
      throw new Error("r2 unavailable");
    }) as unknown as FakeR2Bucket["put"];
    const registry = fakeRegistry();
    const e = env({ UPLOADS_DEFAULT: bucket, REGISTRY: registry });
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) =>
      okProbeResponse(url),
    );

    const record = await probeHostActiveContent(e, "storage.uploads.sh", asFetch(fetchImpl));

    expect(record.ok).toBe(false);
    // The shared probe reports a failed write as its own inconclusive check
    // rather than echoing the storage client's raw error (house style: every
    // verify hint is curated remediation text, never a provider message).
    expect(record.detail).toBe(
      "could not write the image/svg+xml probe to this bucket — check the storage credentials, then check again",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(registry.store.get("host-active-content:storage.uploads.sh")).toEqual(record);
  });
});

describe("runActiveContentHostSweep", () => {
  it("probes every hosted host and returns a record for each", async () => {
    const bucket = new FakeR2Bucket();
    const registry = fakeRegistry();
    const e = env({ UPLOADS_DEFAULT: bucket, REGISTRY: registry });
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) =>
      okProbeResponse(url),
    );

    const results = await runActiveContentHostSweep(e, asFetch(fetchImpl));

    expect(Object.keys(results).sort()).toEqual([...HOSTED_ACTIVE_CONTENT_HOSTS].sort());
    for (const host of HOSTED_ACTIVE_CONTENT_HOSTS) {
      expect(results[host]?.ok).toBe(true);
      expect(registry.store.get(hostActiveContentKey(host))).toEqual(results[host]);
    }
  });

  it("never throws when one host's probe blows up, and still covers the rest", async () => {
    const bucket = new FakeR2Bucket();
    const registry = fakeRegistry();
    const e = env({ UPLOADS_DEFAULT: bucket, REGISTRY: registry });
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
      if (url.includes("store.uploads.sh")) throw new Error("boom");
      return okProbeResponse(url);
    });

    const results = await runActiveContentHostSweep(e, asFetch(fetchImpl));

    expect(Object.keys(results).sort()).toEqual([...HOSTED_ACTIVE_CONTENT_HOSTS].sort());
    expect(results["store.uploads.sh"]?.ok).toBe(false);
    expect(results["storage.uploads.sh"]?.ok).toBe(true);
    expect(results["embed.uploads.sh"]?.ok).toBe(true);
  });

  it("never throws even when REGISTRY.put itself rejects for a host", async () => {
    const bucket = new FakeR2Bucket();
    const registry = fakeRegistry();
    const originalPut = registry.put;
    registry.put = vi.fn(async (key: string, value: string) => {
      if (key.includes("store.uploads.sh")) throw new Error("kv unavailable");
      return (originalPut as unknown as (k: string, v: string) => Promise<void>)(key, value);
    }) as unknown as KVNamespace["put"];
    const e = env({ UPLOADS_DEFAULT: bucket, REGISTRY: registry });
    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) =>
      okProbeResponse(url),
    );

    const results = await runActiveContentHostSweep(e, asFetch(fetchImpl));

    expect(Object.keys(results).sort()).toEqual([...HOSTED_ACTIVE_CONTENT_HOSTS].sort());
    expect(results["store.uploads.sh"]?.ok).toBe(false);
    expect(results["storage.uploads.sh"]?.ok).toBe(true);
  });
});

describe("readHostActiveContent", () => {
  it("returns null when no record exists", async () => {
    const e = env({ REGISTRY: fakeRegistry() });
    expect(await readHostActiveContent(e, "storage.uploads.sh")).toBeNull();
  });

  it("returns the stored record", async () => {
    const record = { ok: true, verifiedAt: new Date().toISOString() };
    const e = env({
      REGISTRY: fakeRegistry({ "host-active-content:storage.uploads.sh": record }),
    });
    expect(await readHostActiveContent(e, "storage.uploads.sh")).toEqual(record);
  });
});
