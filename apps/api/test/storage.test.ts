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

  it("throws secrets_key_unconfigured when the worker holds no WORKSPACE_SECRETS_KEY", async () => {
    const sealed = await encryptSecret("some-other-master-secret", "AKIA");
    const ws: WorkspaceRecord = {
      ...sharedRecord,
      accessKeyId: sealed,
      secretAccessKey: sealed,
    };
    // No WORKSPACE_SECRETS_KEY configured at all, so decrypt has no candidate
    // key. That is a deployment gap on this worker, not a workspace problem.
    const env = {} as unknown as Env;

    await expect(storageConfig(env, ws)).rejects.toMatchObject({
      code: "secrets_key_unconfigured",
      status: 503,
    });
  });

  it("does not tell the caller to reconfigure storage when the key ring is empty", async () => {
    const sealed = await encryptSecret("some-other-master-secret", "AKIA");
    const ws: WorkspaceRecord = {
      ...sharedRecord,
      accessKeyId: sealed,
      secretAccessKey: sealed,
    };
    const env = {} as unknown as Env;

    // Re-entering credentials re-seals with uploads-api's key; a worker with no
    // key still cannot read them. The message must not send anyone there.
    await expect(storageConfig(env, ws)).rejects.toThrow(/will not fix it/);
    await expect(storageConfig(env, ws)).rejects.not.toThrow(/workspace settings/);
  });

  it("throws storage_credentials_unreadable when a key is present but does not open the ciphertext", async () => {
    const sealed = await encryptSecret("some-other-master-secret", "AKIA");
    const ws: WorkspaceRecord = {
      ...sharedRecord,
      accessKeyId: sealed,
      secretAccessKey: sealed,
    };
    const env = { WORKSPACE_SECRETS_KEY: "wrong-master-secret!!!!" } as unknown as Env;

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

describe("storageConfig — provider: s3 (BYO S3-compatible bucket)", () => {
  const s3Record: WorkspaceRecord = {
    provider: "s3",
    bucket: "customer-bucket",
    endpoint: "https://s3.us-east-1.amazonaws.com",
    region: "us-east-1",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "s3cr3t",
  };

  it("resolves an s3 lane and threads its fields through, unsealed", async () => {
    const env = {} as unknown as Env;
    const cfg = await storageConfig(env, s3Record);
    expect(cfg).toMatchObject({
      provider: "s3",
      bucket: "customer-bucket",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      region: "us-east-1",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "s3cr3t",
    });
  });

  it("resolves an s3 lane whose credentials are sealed, same as r2", async () => {
    const env = { WORKSPACE_SECRETS_KEY: "test-master-secret" } as unknown as Env;
    const sealedKey = await encryptSecret("test-master-secret", "AKIAEXAMPLE");
    const sealedSecret = await encryptSecret("test-master-secret", "s3cr3t");
    const ws: WorkspaceRecord = {
      ...s3Record,
      accessKeyId: sealedKey,
      secretAccessKey: sealedSecret,
    };
    const cfg = await storageConfig(env, ws);
    expect(cfg).toMatchObject({
      provider: "s3",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "s3cr3t",
    });
  });

  it("throws storage_misconfigured when region is missing", async () => {
    const env = {} as unknown as Env;
    const { region, ...rest } = s3Record;
    await expect(storageConfig(env, rest as WorkspaceRecord)).rejects.toMatchObject({
      code: "storage_misconfigured",
      status: 503,
    });
  });

  it("throws storage_misconfigured when endpoint is missing", async () => {
    const env = {} as unknown as Env;
    const { endpoint, ...rest } = s3Record;
    await expect(storageConfig(env, rest as WorkspaceRecord)).rejects.toMatchObject({
      code: "storage_misconfigured",
      status: 503,
    });
  });

  it("throws storage_misconfigured for an unknown provider (regression)", async () => {
    const env = {} as unknown as Env;
    const ws = { ...sharedRecord, provider: "gcs" } as unknown as WorkspaceRecord;
    await expect(storageConfig(env, ws)).rejects.toMatchObject({
      code: "storage_misconfigured",
      status: 503,
    });
  });
});
