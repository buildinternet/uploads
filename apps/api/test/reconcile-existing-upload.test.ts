/**
 * `reconcileExistingUpload` (issue #829) — the crash-window recovery primitive
 * behind retry-safe `PUT`. Exercised end-to-end against the real putObject +
 * fake R2/D1 so the head → provenance-sha compare → response synthesis path is
 * covered directly (the idempotency wrapper's control flow is unit-tested with
 * fakes in upload-idempotency.test.ts).
 */
import { describe, expect, it } from "vitest";
import { putObject, reconcileExistingUpload } from "../src/files-core";
import { makePosterEnv, PNG, WORKSPACE } from "./poster-fixtures";

describe("reconcileExistingUpload", () => {
  it("reconstructs the put response when the stored bytes match the sha", async () => {
    const { env, ws } = makePosterEnv();
    const put = await putObject(env, ws, "screenshots/shot.png", PNG, WORKSPACE);
    const sha = put.provenance!["content-sha256"]!;

    const reconciled = await reconcileExistingUpload(env, ws, WORKSPACE, put.key, sha);
    expect(reconciled).not.toBeNull();
    expect(reconciled).toMatchObject({
      key: put.key,
      url: put.url,
      size: put.size,
      contentType: put.contentType,
      replaced: true,
    });
    expect(reconciled!.provenance?.["content-sha256"]).toBe(sha);
  });

  it("echoes the stored queryable metadata (keyed by workspaceName, not ws.name)", async () => {
    const { env, ws } = makePosterEnv();
    const put = await putObject(env, ws, "screenshots/tagged.png", PNG, WORKSPACE, {
      metadata: { project: "acme", stage: "after" },
    });
    const sha = put.provenance!["content-sha256"]!;

    const reconciled = await reconcileExistingUpload(env, ws, WORKSPACE, put.key, sha);
    expect(reconciled!.metadata).toMatchObject({ project: "acme", stage: "after" });
  });

  it("returns null when the stored object's sha differs (a genuine key_exists)", async () => {
    const { env, ws } = makePosterEnv();
    const put = await putObject(env, ws, "screenshots/shot.png", PNG, WORKSPACE);

    const reconciled = await reconcileExistingUpload(
      env,
      ws,
      WORKSPACE,
      put.key,
      "0".repeat(64), // some other request's content hash
    );
    expect(reconciled).toBeNull();
  });

  it("returns null when no object exists at the key", async () => {
    const { env, ws } = makePosterEnv();
    const reconciled = await reconcileExistingUpload(
      env,
      ws,
      WORKSPACE,
      "screenshots/absent.png",
      "0".repeat(64),
    );
    expect(reconciled).toBeNull();
  });
});
