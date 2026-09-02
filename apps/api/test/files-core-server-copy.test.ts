/**
 * `putObject`'s `opts.serverCopy` (issue #929 review, tightened by the
 * adversarial review's M-2): a server-side copy of bytes already stored in
 * this workspace (attach/promote/rotate, via `putOptsFromStoredObject`) is
 * judged by `activeContentAllowedForCopy` rather than the ordinary gate —
 * same active lane, same serving host, so a *freshness* close changes
 * nothing about exposure, but a *policy* close (workspace opt-out, Flagship
 * kill switch, unhealthy lane) still refuses. Everything else
 * `inspectUpload` checks (size, sniffing, plausibility/reputation) applies to
 * a copy exactly as it does to a direct put.
 */
import { describe, expect, it } from "vitest";
import { makePosterEnv, WORKSPACE } from "./poster-fixtures";
import { HOSTED_ACTIVE_CONTENT_HOSTS } from "../src/active-content-hosts";
import { HOST_RECORD_MAX_AGE_MS } from "../src/active-content";
import { putObject } from "../src/files-core";

const INERT_SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
);

const SCRIPTED_SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);

/** A REGISTRY stand-in seeded with one `host-active-content:*` record per hosted host. */
function registryWithHostRecords(record: { ok: boolean; verifiedAt: string }) {
  const store = new Map<string, unknown>(
    HOSTED_ACTIVE_CONTENT_HOSTS.map((host) => [`host-active-content:${host}`, record]),
  );
  return {
    get: (async (key: string) => store.get(key) ?? null) as unknown as KVNamespace["get"],
  } as unknown as KVNamespace;
}

describe("putObject serverCopy — freshness closes are tolerated", () => {
  it("a serverCopy put of SVG bytes succeeds on a lane with no host record at all", async () => {
    // makePosterEnv's env has no REGISTRY, so a shared-lane workspace's
    // gate closes with `host_missing` — a freshness reason, so the copy of
    // already-stored bytes still lands.
    const { env, bucket, ws } = makePosterEnv();
    const result = await putObject(env, ws, "diagrams/copy.svg", INERT_SVG, WORKSPACE, {
      declaredContentType: "image/svg+xml",
      serverCopy: true,
    });
    expect(result.contentType).toBe("image/svg+xml");
    expect(bucket.store.get(`default/${result.key}`)?.contentType).toBe("image/svg+xml");
  });

  it("a serverCopy put succeeds when the only problem is a stale host record", async () => {
    const { env, ws } = makePosterEnv();
    const stale = {
      ok: true,
      verifiedAt: new Date(Date.now() - HOST_RECORD_MAX_AGE_MS - 1000).toISOString(),
    };
    const e = { ...env, REGISTRY: registryWithHostRecords(stale) } as unknown as Env;
    const result = await putObject(e, ws, "diagrams/stale.svg", INERT_SVG, WORKSPACE, {
      declaredContentType: "image/svg+xml",
      serverCopy: true,
    });
    expect(result.contentType).toBe("image/svg+xml");
  });

  it("the same put without serverCopy 415s on the same unverified workspace", async () => {
    const { env, ws } = makePosterEnv();
    await expect(
      putObject(env, ws, "diagrams/direct.svg", INERT_SVG, WORKSPACE, {
        declaredContentType: "image/svg+xml",
      }),
    ).rejects.toMatchObject({ status: 415 });
  });
});

describe("putObject serverCopy — policy closes still refuse (issue #929 M-2)", () => {
  it("415s a serverCopy when the Flagship kill switch is off", async () => {
    const { env, ws } = makePosterEnv();
    const e = {
      ...env,
      FLAGS: { getBooleanValue: async (_k: string, def: boolean) => def },
    } as unknown as Env;
    await expect(
      putObject(e, ws, "diagrams/killed.svg", INERT_SVG, WORKSPACE, {
        declaredContentType: "image/svg+xml",
        serverCopy: true,
      }),
    ).rejects.toMatchObject({ status: 415 });
  });

  it("415s a serverCopy for a workspace that opted out", async () => {
    const { env, ws } = makePosterEnv();
    await expect(
      putObject(
        env,
        { ...ws, activeContentUploads: false },
        "diagrams/opted-out.svg",
        INERT_SVG,
        WORKSPACE,
        { declaredContentType: "image/svg+xml", serverCopy: true },
      ),
    ).rejects.toMatchObject({ status: 415 });
  });

  it("415s a serverCopy onto a lane flagged unhealthy", async () => {
    const { env, ws } = makePosterEnv();
    await expect(
      putObject(
        env,
        { ...ws, storageUnhealthyAt: new Date().toISOString() },
        "diagrams/unhealthy.svg",
        INERT_SVG,
        WORKSPACE,
        { declaredContentType: "image/svg+xml", serverCopy: true },
      ),
    ).rejects.toMatchObject({ status: 415 });
  });
});

/**
 * The reputation pre-filter is not part of the lane gate, so `serverCopy`
 * never widened it — the comment in `guards.ts` that claimed otherwise was
 * wrong (issue #929 adversarial review L-6). This is that claim, tested.
 */
describe("putObject serverCopy still runs the reputation pre-filter", () => {
  it("415s a copy of SVG bytes containing a <script> tag", async () => {
    const { env, ws } = makePosterEnv();
    await expect(
      putObject(env, ws, "diagrams/scripted.svg", SCRIPTED_SVG, WORKSPACE, {
        declaredContentType: "image/svg+xml",
        serverCopy: true,
      }),
    ).rejects.toMatchObject({ status: 415 });
  });
});
