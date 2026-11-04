import { describe, expect, it } from "vitest";
import { isInternalRequest } from "./internal";

const SECRET = "local-internal-key";

function req(headers: Record<string, string>): Request {
  return new Request("https://auth.internal/internal/promote-admin", { headers });
}

describe("isInternalRequest", () => {
  it("allows a matching key even when cf-connecting-ip is present", async () => {
    await expect(
      isInternalRequest(
        req({ "x-uploads-internal-key": SECRET, "cf-connecting-ip": "203.0.113.5" }),
        SECRET,
      ),
    ).resolves.toBe(true);
  });

  it("rejects the legacy header on its own", async () => {
    await expect(isInternalRequest(req({ "x-uploads-internal": "1" }), SECRET)).resolves.toBe(
      false,
    );
  });

  it("rejects a missing, empty, or wrong key", async () => {
    await expect(isInternalRequest(req({}), SECRET)).resolves.toBe(false);
    await expect(isInternalRequest(req({ "x-uploads-internal-key": "" }), SECRET)).resolves.toBe(
      false,
    );
    await expect(
      isInternalRequest(req({ "x-uploads-internal-key": "nope" }), SECRET),
    ).resolves.toBe(false);
    await expect(
      isInternalRequest(req({ "x-uploads-internal-key": `${SECRET}-extra` }), SECRET),
    ).resolves.toBe(false);
  });

  it("rejects every header when the secret is unset or empty", async () => {
    const headers = { "x-uploads-internal-key": SECRET, "x-uploads-internal": "1" };
    await expect(isInternalRequest(req(headers), undefined)).resolves.toBe(false);
    await expect(isInternalRequest(req(headers), "")).resolves.toBe(false);
  });

  it("looks up the header name case-insensitively and compares the value exactly", async () => {
    await expect(
      isInternalRequest(req({ "X-Uploads-Internal-Key": SECRET }), SECRET),
    ).resolves.toBe(true);
    await expect(
      isInternalRequest(req({ "x-uploads-internal-key": SECRET.toUpperCase() }), SECRET),
    ).resolves.toBe(false);
  });
});
