/**
 * `putObject`'s `opts.serverCopy` (issue #929 review): a server-side copy of
 * bytes already stored in this workspace (attach/promote/rotate, via
 * `putOptsFromStoredObject`) bypasses the active-content lane gate — same
 * active lane, same serving host, so a copy changes nothing about exposure.
 * Everything else `inspectUpload` checks (size, sniffing, plausibility) still
 * applies; this only ever widens the allowlist.
 */
import { describe, expect, it } from "vitest";
import { makePosterEnv, WORKSPACE } from "./poster-fixtures";
import { putObject } from "../src/files-core";

const INERT_SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
);

describe("putObject serverCopy bypasses the active-content lane gate", () => {
  it("a serverCopy put of SVG bytes succeeds on an unverified workspace", async () => {
    // makePosterEnv's env has no REGISTRY, so a shared-lane workspace's
    // active-content gate is unconditionally false here (fail-closed) —
    // exactly the "unverified lane" case `serverCopy` needs to bypass.
    const { env, bucket, ws } = makePosterEnv();
    const result = await putObject(env, ws, "diagrams/copy.svg", INERT_SVG, WORKSPACE, {
      declaredContentType: "image/svg+xml",
      serverCopy: true,
    });
    expect(result.contentType).toBe("image/svg+xml");
    expect(bucket.store.get(`default/${result.key}`)?.contentType).toBe("image/svg+xml");
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
