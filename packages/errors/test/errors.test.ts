import { describe, expect, it } from "vitest";
import {
  AppError,
  ERROR_CODES,
  ERROR_TYPES,
  fromWire,
  isAppError,
  isErrorEnvelope,
  isKnownErrorCode,
  InsufficientStorageError,
  IntegrationAuthorizationError,
  InternalError,
  NotFoundError,
  RateLimitedError,
  STATUS_BY_TYPE,
  ValidationError,
  statusForType,
} from "../src/index";

describe("AppError", () => {
  it("derives status from type by default", () => {
    const err = new AppError({ code: "invalid_key", type: "validation", message: "bad key" });
    expect(err.status).toBe(400);
  });

  it("allows an explicit status override", () => {
    const err = new AppError({
      code: "x",
      type: "internal",
      message: "x",
      status: 418,
    });
    expect(err.status).toBe(418);
  });

  it("toWire emits the nested envelope with details", () => {
    const err = new ValidationError("invalid key", {
      code: "invalid_key",
      details: { key: ".." },
    });
    expect(err.toWire()).toEqual({
      error: {
        code: "invalid_key",
        type: "validation",
        message: "invalid key",
        details: { key: ".." },
      },
    });
  });

  it("toWire omits details when absent", () => {
    const err = new NotFoundError();
    expect(err.toWire()).toEqual({
      error: { code: "not_found", type: "not_found", message: "Not found." },
    });
  });

  it("toWire hides the real message when expose is false", () => {
    const err = new InternalError("secret db dsn");
    expect(err.toWire().error.message).toBe("Something went wrong.");
  });

  it("isAppError is a working guard", () => {
    expect(isAppError(new ValidationError())).toBe(true);
    expect(isAppError(new Error("plain"))).toBe(false);
  });

  it("from() returns AppError instances unchanged", () => {
    const original = new NotFoundError("gone");
    expect(AppError.from(original)).toBe(original);
  });

  it("from() wraps a plain Error as a non-exposed internal error", () => {
    const wrapped = AppError.from(new Error("boom"));
    expect(wrapped.type).toBe("internal");
    expect(wrapped.code).toBe("internal_error");
    expect(wrapped.status).toBe(500);
    expect(wrapped.expose).toBe(false);
    expect(wrapped.toWire().error.message).toBe("Something went wrong.");
  });
});

describe("subclasses", () => {
  it("RateLimitedError carries retry_after in details", () => {
    const err = new RateLimitedError("slow down", { retryAfterSeconds: 30 });
    expect(err.status).toBe(429);
    expect(err.toWire().error.details).toEqual({ retry_after: 30 });
  });

  it("InsufficientStorageError maps to 507", () => {
    const err = new InsufficientStorageError("quota", {
      code: "storage_quota_exceeded",
      details: { maxStorageBytes: 100 },
    });
    expect(err.status).toBe(507);
    expect(err.type).toBe("insufficient_storage");
    expect(err.code).toBe("storage_quota_exceeded");
  });

  it("IntegrationAuthorizationError is a 403 carrying provider + required + fix_url", () => {
    const err = new IntegrationAuthorizationError("GitHub App", {
      required: ["issues:write", "pull_requests:write"],
      fixUrl: "https://github.com/organizations/acme/settings/installations/1/permissions/update",
      message: "GitHub App needs write approved for acme.",
    });
    expect(err.status).toBe(403);
    expect(err.type).toBe("forbidden");
    expect(err.code).toBe("integration_authorization_required");
    expect(err.toWire().error.details).toEqual({
      provider: "GitHub App",
      required: ["issues:write", "pull_requests:write"],
      fix_url: "https://github.com/organizations/acme/settings/installations/1/permissions/update",
    });
    expect(err.toWire().error.message).toBe("GitHub App needs write approved for acme.");
  });
});

describe("fromWire", () => {
  it("round-trips through toWire", () => {
    const original = new ValidationError("invalid key", {
      code: "invalid_key",
      details: { allowedKeyPrefixes: ["f/"] },
    });
    const decoded = fromWire(original.toWire());
    expect(decoded.code).toBe("invalid_key");
    expect(decoded.type).toBe("validation");
    expect(decoded.status).toBe(400);
    expect(decoded.message).toBe("invalid key");
    expect(decoded.details).toEqual({ allowedKeyPrefixes: ["f/"] });
  });

  it("never throws on malformed bodies", () => {
    const decoded = fromWire({ error: "flat legacy" });
    expect(decoded.code).toBe("malformed_error_response");
    expect(decoded.expose).toBe(false);
  });
});

describe("registry", () => {
  it("every ERROR_TYPE has a status mapping", () => {
    for (const type of ERROR_TYPES) {
      expect(typeof STATUS_BY_TYPE[type]).toBe("number");
      expect(statusForType(type)).toBe(STATUS_BY_TYPE[type]);
    }
  });

  it("isKnownErrorCode matches the registry", () => {
    expect(isKnownErrorCode("invalid_key")).toBe(true);
    expect(isKnownErrorCode("not_a_real_code")).toBe(false);
    expect(ERROR_CODES).toContain("storage_quota_exceeded");
  });

  it("isErrorEnvelope validates structure", () => {
    expect(
      isErrorEnvelope({
        error: { code: "x", type: "validation", message: "y" },
      }),
    ).toBe(true);
    expect(isErrorEnvelope({ error: "flat" })).toBe(false);
    expect(isErrorEnvelope(null)).toBe(false);
  });
});
