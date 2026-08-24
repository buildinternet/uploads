/**
 * `reconcileInterruptedUpload` (issue #829) — the crash-window recovery behind
 * retry-safe `PUT`. A prior attempt's bytes can land in R2 before its D1 work
 * (metadata, content-hash index) runs; on the retry, `putObject` throws
 * `key_exists`, and this re-drives the write (with `replace`) so the object
 * converges to the intended state — rather than reporting success with the
 * requested metadata silently dropped. Exercised end-to-end against the real
 * putObject + fake R2/D1.
 */
import { describe, expect, it } from "vitest";
import { getFileMetadata } from "../src/file-metadata";
import { putObject, reconcileInterruptedUpload } from "../src/files-core";
import { makePosterEnv, PNG, WORKSPACE } from "./poster-fixtures";

const OPTS = { surface: "api" as const };

describe("reconcileInterruptedUpload", () => {
  it("re-applies metadata a crashed attempt never wrote (the correctness case)", async () => {
    const { env, ws } = makePosterEnv();
    // Simulate the crash window: the object landed in R2 but its D1 metadata
    // never got written — modeled here as a put that carried no metadata.
    const put = await putObject(env, ws, "screenshots/shot.png", PNG, WORKSPACE, OPTS);
    const sha = put.provenance!["content-sha256"]!;
    expect(await getFileMetadata(env.DB, WORKSPACE, put.key)).toEqual({});

    // The retry carried `X-Uploads-Meta-*`; reconcile must converge them.
    const reconciled = await reconcileInterruptedUpload(env, ws, WORKSPACE, put.key, PNG, sha, {
      ...OPTS,
      metadata: { project: "acme", stage: "after" },
    });
    expect(reconciled).not.toBeNull();
    expect(reconciled!.metadata).toMatchObject({ project: "acme", stage: "after" });
    expect(reconciled!.key).toBe(put.key);
    // The D1 tier now actually holds them — not just the echoed response.
    expect(await getFileMetadata(env.DB, WORKSPACE, put.key)).toMatchObject({
      project: "acme",
      stage: "after",
    });
  });

  it("returns null and does not overwrite when the stored sha differs", async () => {
    const { env, ws } = makePosterEnv();
    const put = await putObject(env, ws, "screenshots/shot.png", PNG, WORKSPACE, {
      ...OPTS,
      metadata: { keep: "original" },
    });

    const reconciled = await reconcileInterruptedUpload(
      env,
      ws,
      WORKSPACE,
      put.key,
      PNG,
      "0".repeat(64), // a different request's content hash
      { ...OPTS, metadata: { should: "not-apply" } },
    );
    expect(reconciled).toBeNull();
  });

  it("returns null when no object exists at the key", async () => {
    const { env, ws } = makePosterEnv();
    const reconciled = await reconcileInterruptedUpload(
      env,
      ws,
      WORKSPACE,
      "screenshots/absent.png",
      PNG,
      "0".repeat(64),
      OPTS,
    );
    expect(reconciled).toBeNull();
  });
});
