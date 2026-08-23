import { describe, expect, it } from "vitest";
import { parseAccountIdOrEndpoint } from "./r2-endpoint";

const ACCOUNT_ID = "a".repeat(32);

describe("parseAccountIdOrEndpoint", () => {
  it("accepts a bare 32-char hex account id", () => {
    expect(parseAccountIdOrEndpoint(ACCOUNT_ID)).toEqual({ accountId: ACCOUNT_ID });
  });

  it("uppercases in a bare account id are normalized to lowercase", () => {
    expect(parseAccountIdOrEndpoint(ACCOUNT_ID.toUpperCase())).toEqual({ accountId: ACCOUNT_ID });
  });

  it("trims surrounding whitespace", () => {
    expect(parseAccountIdOrEndpoint(`  ${ACCOUNT_ID}  `)).toEqual({ accountId: ACCOUNT_ID });
  });

  it("parses the default (no-jurisdiction) endpoint URL", () => {
    expect(parseAccountIdOrEndpoint(`https://${ACCOUNT_ID}.r2.cloudflarestorage.com`)).toEqual({
      accountId: ACCOUNT_ID,
      jurisdiction: undefined,
    });
  });

  it("parses an endpoint URL with a trailing slash", () => {
    expect(parseAccountIdOrEndpoint(`https://${ACCOUNT_ID}.r2.cloudflarestorage.com/`)).toEqual({
      accountId: ACCOUNT_ID,
      jurisdiction: undefined,
    });
  });

  it("parses the eu jurisdiction out of an endpoint URL", () => {
    expect(parseAccountIdOrEndpoint(`https://${ACCOUNT_ID}.eu.r2.cloudflarestorage.com`)).toEqual({
      accountId: ACCOUNT_ID,
      jurisdiction: "eu",
    });
  });

  it("parses the fedramp jurisdiction out of an endpoint URL", () => {
    expect(
      parseAccountIdOrEndpoint(`https://${ACCOUNT_ID}.fedramp.r2.cloudflarestorage.com`),
    ).toEqual({ accountId: ACCOUNT_ID, jurisdiction: "fedramp" });
  });

  it("is case-insensitive on the endpoint host and normalizes to lowercase", () => {
    expect(
      parseAccountIdOrEndpoint(`https://${ACCOUNT_ID.toUpperCase()}.EU.R2.CLOUDFLARESTORAGE.COM`),
    ).toEqual({ accountId: ACCOUNT_ID, jurisdiction: "eu" });
  });

  it("returns null for garbage input", () => {
    expect(parseAccountIdOrEndpoint("not an account id or url")).toBeNull();
  });

  it("returns null for an empty/whitespace-only input", () => {
    expect(parseAccountIdOrEndpoint("   ")).toBeNull();
  });

  it("returns null for a non-R2 https URL", () => {
    expect(parseAccountIdOrEndpoint("https://example.com")).toBeNull();
  });

  it("returns null for an http (non-https) endpoint URL", () => {
    expect(parseAccountIdOrEndpoint(`http://${ACCOUNT_ID}.r2.cloudflarestorage.com`)).toBeNull();
  });

  it("returns null for a too-short hex string", () => {
    expect(parseAccountIdOrEndpoint("a".repeat(31))).toBeNull();
  });
});
