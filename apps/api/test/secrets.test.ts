import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  openCredentialFields,
  sealCredentialFields,
} from "../src/secrets";

const MASTER = "test-master-secret-key!!";

describe("workspace secret encryption", () => {
  it("round-trips AES-GCM", async () => {
    const enc = await encryptSecret(MASTER, "s3-secret-value");
    expect(isEncryptedSecret(enc)).toBe(true);
    expect(await decryptSecret(MASTER, enc)).toBe("s3-secret-value");
  });

  it("passes through plaintext when not encrypted", async () => {
    expect(await decryptSecret(MASTER, "plain")).toBe("plain");
    expect(await decryptSecret(undefined, "plain")).toBe("plain");
  });

  it("seals and opens credential fields", async () => {
    const sealed = await sealCredentialFields(MASTER, {
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
    });
    expect(isEncryptedSecret(sealed.accessKeyId!)).toBe(true);
    expect(isEncryptedSecret(sealed.secretAccessKey!)).toBe(true);
    const opened = await openCredentialFields(MASTER, sealed);
    expect(opened).toEqual({ accessKeyId: "AKIA", secretAccessKey: "secret" });
  });

  it("leaves fields alone without master secret", async () => {
    const fields = { accessKeyId: "AKIA", secretAccessKey: "secret" };
    expect(await sealCredentialFields(undefined, fields)).toEqual(fields);
  });
});
