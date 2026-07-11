import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  openCredentialFields,
  resealCredentialFields,
  sealCredentialFields,
  secretsKeyRingFromEnv,
} from "../src/secrets";

const CURRENT = "test-master-secret-key!!";
const PREVIOUS = "previous-master-secret!!";

describe("workspace secret encryption", () => {
  it("round-trips AES-GCM", async () => {
    const enc = await encryptSecret(CURRENT, "s3-secret-value");
    expect(isEncryptedSecret(enc)).toBe(true);
    expect((await decryptSecret(CURRENT, enc)).plaintext).toBe("s3-secret-value");
  });

  it("passes through plaintext when not encrypted", async () => {
    expect((await decryptSecret(CURRENT, "plain")).plaintext).toBe("plain");
    expect((await decryptSecret(undefined, "plain")).plaintext).toBe("plain");
  });

  it("decrypts with previous key during rotation", async () => {
    const enc = await encryptSecret(PREVIOUS, "legacy-secret");
    const ring = { current: CURRENT, previous: PREVIOUS };
    const r = await decryptSecret(ring, enc);
    expect(r.plaintext).toBe("legacy-secret");
    expect(r.usedPrevious).toBe(true);
  });

  it("prefers current over previous", async () => {
    const enc = await encryptSecret(CURRENT, "new-secret");
    const ring = { current: CURRENT, previous: PREVIOUS };
    const r = await decryptSecret(ring, enc);
    expect(r.plaintext).toBe("new-secret");
    expect(r.usedPrevious).toBe(false);
  });

  it("openCredentialFields sets usedPrevious when needed", async () => {
    const sealed = await sealCredentialFields(PREVIOUS, {
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
    });
    const opened = await openCredentialFields({ current: CURRENT, previous: PREVIOUS }, sealed);
    expect(opened).toMatchObject({
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      usedPrevious: true,
    });
  });

  it("reseal rewrites ciphertext under current key", async () => {
    const sealedOld = await sealCredentialFields(PREVIOUS, {
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
    });
    const resealed = await resealCredentialFields(
      { current: CURRENT, previous: PREVIOUS },
      sealedOld,
    );
    expect(resealed.changed).toBe(true);
    // Must decrypt with current alone (no previous).
    const opened = await openCredentialFields(CURRENT, {
      accessKeyId: resealed.accessKeyId,
      secretAccessKey: resealed.secretAccessKey,
    });
    expect(opened.accessKeyId).toBe("AKIA");
    expect(opened.secretAccessKey).toBe("secret");
    expect(opened.usedPrevious).toBe(false);
  });

  it("secretsKeyRingFromEnv maps both secrets", () => {
    expect(
      secretsKeyRingFromEnv({
        WORKSPACE_SECRETS_KEY: "a".repeat(16),
        WORKSPACE_SECRETS_KEY_PREVIOUS: "b".repeat(16),
      }),
    ).toEqual({
      current: "a".repeat(16),
      previous: "b".repeat(16),
    });
  });

  it("leaves fields alone without master secret", async () => {
    const fields = { accessKeyId: "AKIA", secretAccessKey: "secret" };
    expect(await sealCredentialFields(undefined, fields)).toEqual(fields);
  });
});
