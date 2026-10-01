import { describe, expect, it } from "vitest";
import {
  consentTrust,
  describeRedirectDestination,
  redirectDestinationFromQuery,
} from "./oauth-redirect-destination";

describe("describeRedirectDestination", () => {
  it("returns the host of an https redirect, including a non-default port", () => {
    expect(describeRedirectDestination("https://attacker.example.com/cb")).toEqual({
      kind: "web",
      host: "attacker.example.com",
    });
    expect(describeRedirectDestination("https://app.example.com:8443/cb")).toEqual({
      kind: "web",
      host: "app.example.com:8443",
    });
  });

  it("treats loopback redirects as an app on this device", () => {
    for (const uri of [
      "http://127.0.0.1:6276/oauth/callback",
      "http://localhost:3000/cb",
      "http://[::1]:9000/cb",
    ]) {
      expect(describeRedirectDestination(uri)).toEqual({ kind: "local" });
    }
  });

  it("names the scheme of a private-use redirect", () => {
    expect(describeRedirectDestination("cursor://anysphere.cursor-mcp/oauth/callback")).toEqual({
      kind: "app",
      scheme: "cursor",
    });
  });

  it("returns null for a missing or unparseable redirect", () => {
    expect(describeRedirectDestination(undefined)).toBeNull();
    expect(describeRedirectDestination("")).toBeNull();
    expect(describeRedirectDestination("not a url")).toBeNull();
  });
});

describe("redirectDestinationFromQuery", () => {
  it("reads redirect_uri from a consent query string", () => {
    const search =
      "?client_id=abc&redirect_uri=https%3A%2F%2Fattacker.example.com%2Fcb&scope=files%3Aread&sig=x";
    expect(redirectDestinationFromQuery(search)).toEqual({
      kind: "web",
      host: "attacker.example.com",
    });
  });

  it("returns null when the query has no redirect_uri", () => {
    expect(redirectDestinationFromQuery("?client_id=abc")).toBeNull();
  });
});

describe("consentTrust", () => {
  it("is verified only for an explicit official: true", () => {
    expect(consentTrust(true, { kind: "web", host: "releases.sh" })).toBe("verified");
    expect(consentTrust(true, null)).toBe("verified");
    expect(consentTrust(false, { kind: "local" })).not.toBe("verified");
    expect(consentTrust(undefined, { kind: "local" })).not.toBe("verified");
  });

  it("treats loopback and private-scheme redirects as unverified-local", () => {
    expect(consentTrust(false, { kind: "local" })).toBe("unverified-local");
    expect(consentTrust(undefined, { kind: "app", scheme: "cursor" })).toBe("unverified-local");
  });

  it("warns for a remote web redirect or an unknown destination", () => {
    expect(consentTrust(false, { kind: "web", host: "attacker.example.com" })).toBe(
      "unverified-web",
    );
    expect(consentTrust(undefined, null)).toBe("unverified-web");
  });
});
