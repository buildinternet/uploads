import { describe, expect, it } from "vitest";
import {
  clampDcrRegistrationResult,
  dcrClientRowPatch,
  sanitizeDcrRegistrationBody,
} from "./oauth-dcr";

describe("sanitizeDcrRegistrationBody", () => {
  it("forces a confidential registration onto public PKCE", () => {
    expect(
      sanitizeDcrRegistrationBody({
        client_name: "probe-alpha",
        redirect_uris: ["https://attacker.example.com/cb"],
        token_endpoint_auth_method: "client_secret_basic",
        scope: "files:read files:write offline_access files:delete",
      }),
    ).toEqual({
      client_name: "probe-alpha",
      redirect_uris: ["https://attacker.example.com/cb"],
      token_endpoint_auth_method: "none",
      scope: "files:read files:write offline_access files:delete",
    });
  });

  it("forces none when token_endpoint_auth_method is omitted", () => {
    expect(
      sanitizeDcrRegistrationBody({
        client_name: "MCP Inspector",
        redirect_uris: ["https://app.example.com/callback"],
      }),
    ).toEqual({
      client_name: "MCP Inspector",
      redirect_uris: ["https://app.example.com/callback"],
      token_endpoint_auth_method: "none",
    });
  });

  it("strips skip_consent, trusted, secrets, and private_key_jwt material", () => {
    const out = sanitizeDcrRegistrationBody({
      client_name: "Evil",
      token_endpoint_auth_method: "private_key_jwt",
      skip_consent: true,
      trusted: true,
      client_secret: "forged-secret",
      jwks: { keys: [] },
      jwks_uri: "https://attacker.example.com/jwks",
      client_credentials_scopes: ["files:write"],
    });
    expect(out).toEqual({
      client_name: "Evil",
      token_endpoint_auth_method: "none",
    });
    expect(out).not.toHaveProperty("skip_consent");
    expect(out).not.toHaveProperty("trusted");
    expect(out).not.toHaveProperty("client_secret");
    expect(out).not.toHaveProperty("jwks");
    expect(out).not.toHaveProperty("jwks_uri");
    expect(out).not.toHaveProperty("client_credentials_scopes");
  });

  it("drops client_credentials from advertised grant_types", () => {
    expect(
      sanitizeDcrRegistrationBody({
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token", "client_credentials"],
      }),
    ).toEqual({
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
  });

  it("does not rewrite scope when forcing public PKCE", () => {
    const out = sanitizeDcrRegistrationBody({
      token_endpoint_auth_method: "client_secret_post",
      scope: "files:read files:write offline_access",
    });
    expect(out?.scope).toBe("files:read files:write offline_access");
  });

  it("leaves an already-public MCP body alone", () => {
    expect(
      sanitizeDcrRegistrationBody({
        client_name: "MCP Inspector",
        redirect_uris: ["https://app.example.com/callback"],
        token_endpoint_auth_method: "none",
      }),
    ).toBeUndefined();
  });
});

describe("dcrClientRowPatch / registration result clamp", () => {
  it("never stores skip_consent, a secret, or a secret-bearing auth method", () => {
    expect(dcrClientRowPatch()).toEqual({
      skipConsent: false,
      tokenEndpointAuthMethod: "none",
      public: true,
      requirePKCE: true,
      clientCredentialsScopes: null,
      clientSecret: null,
      jwks: null,
      jwksUri: null,
    });
  });

  it("rewrites a 201 body so it cannot return a client_secret or skip_consent", () => {
    const returned = {
      client_id: "abc",
      client_secret: "leaked",
      client_secret_expires_at: 0,
      scope: "files:read files:write offline_access files:delete",
      token_endpoint_auth_method: "client_secret_basic",
      skip_consent: true,
      trusted: true,
      grant_types: ["authorization_code", "refresh_token", "client_credentials"],
    };
    expect(clampDcrRegistrationResult(returned)).toBe("abc");
    expect(returned.scope).toBe("files:read files:write offline_access files:delete");
    expect(returned.token_endpoint_auth_method).toBe("none");
    expect(returned.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect("client_secret" in returned).toBe(false);
    expect("client_secret_expires_at" in returned).toBe(false);
    expect("skip_consent" in returned).toBe(false);
    expect("trusted" in returned).toBe(false);
  });

  it("ignores errors and raw Response objects", () => {
    expect(clampDcrRegistrationResult(new Error("nope"))).toBeUndefined();
    expect(clampDcrRegistrationResult(new Response("{}", { status: 201 }))).toBeUndefined();
  });
});
