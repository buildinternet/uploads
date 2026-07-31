import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { respondError } from "../src/error-response";
import { encryptSecret } from "../src/secrets";
import { storageConfig } from "../src/storage";
import type { WorkspaceRecord } from "../src/workspace";

const sharedRecord: WorkspaceRecord = {
  provider: "r2",
  bucket: "uploads-default",
  prefix: "acme/",
  publicBaseUrl: "https://storage.uploads.sh",
};

describe("storageConfig", () => {
  it("throws storage_misconfigured for a workspace record naming an unknown R2 binding", async () => {
    const ws: WorkspaceRecord = { ...sharedRecord, binding: "NOT_A_REAL_BINDING" };
    const env = {} as unknown as Env;

    await expect(storageConfig(env, ws)).rejects.toMatchObject({
      code: "storage_misconfigured",
      status: 503,
    });
  });

  it("route layer translates the unknown-binding error to a 503 with a hint, not a 500", async () => {
    const ws: WorkspaceRecord = { ...sharedRecord, binding: "NOT_A_REAL_BINDING" };
    const env = {} as unknown as Env;
    const app = new Hono<{ Bindings: Env }>()
      .get("/check", async (c) => {
        await storageConfig(c.env, ws);
        return c.json({ ok: true });
      })
      .onError((err, c) => respondError(c, err));

    const res = await app.request("/check", {}, env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("storage_misconfigured");
    expect(body.error.message).toContain("NOT_A_REAL_BINDING");
  });

  it("throws storage_credentials_unreadable when the ciphertext cannot be decrypted", async () => {
    const sealed = await encryptSecret("some-other-master-secret", "AKIA");
    const ws: WorkspaceRecord = {
      ...sharedRecord,
      accessKeyId: sealed,
      secretAccessKey: sealed,
    };
    // No WORKSPACE_SECRETS_KEY configured at all, so decrypt has no candidate key.
    const env = {} as unknown as Env;

    await expect(storageConfig(env, ws)).rejects.toMatchObject({
      code: "storage_credentials_unreadable",
      status: 503,
    });
  });

  it("route layer translates the decrypt failure to a 503, not a 500", async () => {
    const sealed = await encryptSecret("some-other-master-secret", "AKIA");
    const ws: WorkspaceRecord = {
      ...sharedRecord,
      accessKeyId: sealed,
      secretAccessKey: sealed,
    };
    const env = { WORKSPACE_SECRETS_KEY: "wrong-master-secret!!!!" } as unknown as Env;
    const app = new Hono<{ Bindings: Env }>()
      .get("/check", async (c) => {
        await storageConfig(c.env, ws);
        return c.json({ ok: true });
      })
      .onError((err, c) => respondError(c, err));

    const res = await app.request("/check", {}, env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("storage_credentials_unreadable");
  });

  it("still resolves normally for a well-formed shared-bucket record with no credentials", async () => {
    const env = {} as unknown as Env;
    const cfg = await storageConfig(env, sharedRecord);
    expect(cfg.bucket).toBe("uploads-default");
    expect(cfg.prefix).toBe("acme/");
  });
});
