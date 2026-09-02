import { describe, expect, it } from "vitest";
import {
  ACTIVE_CONTENT_FLAG,
  HOST_RECORD_MAX_AGE_MS,
  LANE_STAMP_MAX_AGE_MS,
  activeContentAllowed,
} from "./active-content";
import type { WorkspaceRecord } from "./workspace";

const NOW = new Date("2026-09-02T12:00:00.000Z");

const flagsOn = { getBooleanValue: async () => true };
const flagsOff = { getBooleanValue: async (_k: string, def: boolean) => def };
const flagsThrows = {
  getBooleanValue: async () => {
    throw new Error("flagship unreachable");
  },
};

/** In-memory REGISTRY KV stand-in — `get` over a Map, seeded with host records. */
function fakeRegistry(records: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(records));
  return {
    get: (async (key: string) => store.get(key) ?? null) as unknown as KVNamespace["get"],
  };
}

function env(over: Record<string, unknown> = {}) {
  return {
    FLAGS: flagsOn,
    REGISTRY: fakeRegistry(),
    ...over,
  } as unknown as Env;
}

const SHARED_WS: WorkspaceRecord = {
  provider: "r2",
  bucket: "shared",
  binding: "UPLOADS_DEFAULT",
  publicBaseUrl: "https://storage.uploads.sh",
};

const BYO_WS: WorkspaceRecord = {
  provider: "r2",
  bucket: "acme-bucket",
  publicBaseUrl: "https://cdn.acme.example",
  accountId: "acct",
  accessKeyId: "enc:v1:x",
  secretAccessKey: "enc:v1:y",
};

function isoAgo(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe("activeContentAllowed — cheap local gates", () => {
  it("denies when the workspace opted out, before touching FLAGS or REGISTRY", async () => {
    expect(
      await activeContentAllowed(
        env({ FLAGS: undefined, REGISTRY: undefined }),
        { ...SHARED_WS, activeContentUploads: false },
        NOW,
      ),
    ).toBe(false);
  });

  it("denies when the FLAGS binding is absent entirely", async () => {
    expect(await activeContentAllowed(env({ FLAGS: undefined }), SHARED_WS, NOW)).toBe(false);
  });

  it("fails closed when Flagship evaluation falls back to the default", async () => {
    expect(await activeContentAllowed(env({ FLAGS: flagsOff }), SHARED_WS, NOW)).toBe(false);
  });

  it("fails closed when Flagship evaluation throws", async () => {
    expect(await activeContentAllowed(env({ FLAGS: flagsThrows }), SHARED_WS, NOW)).toBe(false);
  });

  it("checks the flag with the documented flag key and a false default", async () => {
    let seen: [string, boolean] | null = null;
    const capturing = {
      getBooleanValue: async (key: string, def: boolean) => {
        seen = [key, def];
        return true;
      },
    };
    const registry = fakeRegistry({
      "host-active-content:storage.uploads.sh": { ok: true, verifiedAt: isoAgo(0) },
    });
    await activeContentAllowed(env({ FLAGS: capturing, REGISTRY: registry }), SHARED_WS, NOW);
    expect(seen).toEqual([ACTIVE_CONTENT_FLAG, false]);
  });

  it("denies when the active lane is flagged unhealthy, regardless of lane state", async () => {
    const registry = fakeRegistry({
      "host-active-content:storage.uploads.sh": { ok: true, verifiedAt: isoAgo(0) },
    });
    expect(
      await activeContentAllowed(
        env({ REGISTRY: registry }),
        { ...SHARED_WS, storageUnhealthyAt: isoAgo(1000) },
        NOW,
      ),
    ).toBe(false);
    expect(
      await activeContentAllowed(
        env(),
        {
          ...BYO_WS,
          storageActiveContentVerifiedAt: isoAgo(0),
          storageUnhealthyAt: isoAgo(1000),
        },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("activeContentAllowed — shared lane", () => {
  it("allows when the host's KV record is ok and fresh", async () => {
    const registry = fakeRegistry({
      "host-active-content:storage.uploads.sh": { ok: true, verifiedAt: isoAgo(1000) },
    });
    expect(await activeContentAllowed(env({ REGISTRY: registry }), SHARED_WS, NOW)).toBe(true);
  });

  it("denies when the host's KV record is stale (older than HOST_RECORD_MAX_AGE_MS)", async () => {
    const registry = fakeRegistry({
      "host-active-content:storage.uploads.sh": {
        ok: true,
        verifiedAt: isoAgo(HOST_RECORD_MAX_AGE_MS + 1),
      },
    });
    expect(await activeContentAllowed(env({ REGISTRY: registry }), SHARED_WS, NOW)).toBe(false);
  });

  it("allows exactly at the HOST_RECORD_MAX_AGE_MS boundary", async () => {
    const registry = fakeRegistry({
      "host-active-content:storage.uploads.sh": {
        ok: true,
        verifiedAt: isoAgo(HOST_RECORD_MAX_AGE_MS),
      },
    });
    expect(await activeContentAllowed(env({ REGISTRY: registry }), SHARED_WS, NOW)).toBe(true);
  });

  it("denies when no host record has ever been written", async () => {
    expect(await activeContentAllowed(env({ REGISTRY: fakeRegistry() }), SHARED_WS, NOW)).toBe(
      false,
    );
  });

  it("denies when the host record exists but failed its probe (ok: false)", async () => {
    const registry = fakeRegistry({
      "host-active-content:storage.uploads.sh": { ok: false, verifiedAt: isoAgo(0) },
    });
    expect(await activeContentAllowed(env({ REGISTRY: registry }), SHARED_WS, NOW)).toBe(false);
  });

  it("denies when the shared workspace has no publicBaseUrl to derive a host from", async () => {
    const { publicBaseUrl: _unused, ...noUrl } = SHARED_WS;
    expect(await activeContentAllowed(env(), noUrl, NOW)).toBe(false);
  });
});

describe("activeContentAllowed — BYO lane", () => {
  it("allows when storageActiveContentVerifiedAt is fresh", async () => {
    expect(
      await activeContentAllowed(
        env(),
        { ...BYO_WS, storageActiveContentVerifiedAt: isoAgo(1000) },
        NOW,
      ),
    ).toBe(true);
  });

  it("denies when storageActiveContentVerifiedAt is stale (older than LANE_STAMP_MAX_AGE_MS)", async () => {
    expect(
      await activeContentAllowed(
        env(),
        { ...BYO_WS, storageActiveContentVerifiedAt: isoAgo(LANE_STAMP_MAX_AGE_MS + 1) },
        NOW,
      ),
    ).toBe(false);
  });

  it("allows exactly at the LANE_STAMP_MAX_AGE_MS boundary", async () => {
    expect(
      await activeContentAllowed(
        env(),
        { ...BYO_WS, storageActiveContentVerifiedAt: isoAgo(LANE_STAMP_MAX_AGE_MS) },
        NOW,
      ),
    ).toBe(true);
  });

  it("denies when the lane has never been verified", async () => {
    expect(await activeContentAllowed(env(), BYO_WS, NOW)).toBe(false);
  });

  it("never touches REGISTRY for a BYO lane", async () => {
    const registry = {
      get: async () => {
        throw new Error("REGISTRY should not be read for a BYO lane");
      },
    } as unknown as KVNamespace;
    expect(
      await activeContentAllowed(
        env({ REGISTRY: registry }),
        { ...BYO_WS, storageActiveContentVerifiedAt: isoAgo(0) },
        NOW,
      ),
    ).toBe(true);
  });
});
