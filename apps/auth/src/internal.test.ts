import { describe, expect, it } from "vitest";
import { isInternalRequest } from "./internal";

function req(headers: Record<string, string>): Request {
  return new Request("https://auth.internal/internal/promote-admin", { headers });
}

describe("isInternalRequest", () => {
  it("allows when the internal header is set and cf-connecting-ip is absent", () => {
    expect(isInternalRequest(req({ "x-uploads-internal": "1" }))).toBe(true);
  });

  it("rejects when the internal header is missing", () => {
    expect(isInternalRequest(req({}))).toBe(false);
  });

  it("rejects when cf-connecting-ip is present, even with the internal header", () => {
    expect(
      isInternalRequest(req({ "x-uploads-internal": "1", "cf-connecting-ip": "203.0.113.5" })),
    ).toBe(false);
  });

  it("rejects a wrong/empty value for the internal header", () => {
    expect(isInternalRequest(req({ "x-uploads-internal": "true" }))).toBe(false);
    expect(isInternalRequest(req({ "x-uploads-internal": "" }))).toBe(false);
  });

  it("is case-insensitive on header name lookup (Request headers are inherently case-insensitive)", () => {
    expect(isInternalRequest(req({ "X-Uploads-Internal": "1" }))).toBe(true);
    expect(
      isInternalRequest(req({ "x-uploads-internal": "1", "CF-Connecting-IP": "203.0.113.5" })),
    ).toBe(false);
  });
});
