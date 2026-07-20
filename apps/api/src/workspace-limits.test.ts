import { describe, expect, it } from "vitest";
import { validateLimitsPatch } from "./workspace-limits";

describe("validateLimitsPatch", () => {
  it("accepts positive integers for each field", () => {
    expect(
      validateLimitsPatch({
        maxStorageBytes: 250_000_000,
        maxUploadsPerPeriod: 3000,
        maxUploadBytes: 25_000_000,
        maxVideoUploadBytes: 8_000_000,
      }),
    ).toEqual({
      maxStorageBytes: 250_000_000,
      maxUploadsPerPeriod: 3000,
      maxUploadBytes: 25_000_000,
      maxVideoUploadBytes: 8_000_000,
    });
  });

  it("accepts null (clear to unlimited)", () => {
    expect(validateLimitsPatch({ maxStorageBytes: null })).toEqual({ maxStorageBytes: null });
  });

  it("only includes fields present in the body and ignores unknown keys", () => {
    expect(validateLimitsPatch({ maxUploadBytes: 5, somethingElse: 9 })).toEqual({
      maxUploadBytes: 5,
    });
  });

  it("rejects zero, negatives, and non-integers", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateLimitsPatch({ maxStorageBytes: bad })).toThrow(
        /invalid_limit|positive/i,
      );
    }
  });

  it("rejects non-number, non-null values", () => {
    for (const bad of ["100", true, {}, []]) {
      expect(() => validateLimitsPatch({ maxUploadsPerPeriod: bad })).toThrow();
    }
  });

  it("rejects a non-object body", () => {
    expect(() => validateLimitsPatch(null)).toThrow();
    expect(() => validateLimitsPatch("nope")).toThrow();
    expect(() => validateLimitsPatch([1, 2])).toThrow();
  });

  it("carries code invalid_limit on the thrown error", () => {
    try {
      validateLimitsPatch({ maxStorageBytes: -5 });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("invalid_limit");
    }
  });
});
