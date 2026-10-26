import { describe, expect, it } from "vitest";
import {
  cimdPrivateKeyJwtJwksUri,
  cimdClientRowFixups,
  clampDcrRegistrationResult,
  dcrClientRowPatch,
  dcrRegistrationRejection,
  sanitizeCimdMetadataDocument,
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

  it("strips skip_consent, trusted, official, secrets, and private_key_jwt material", () => {
    const out = sanitizeDcrRegistrationBody({
      client_name: "Evil",
      token_endpoint_auth_method: "private_key_jwt",
      skip_consent: true,
      trusted: true,
      client_secret: "forged-secret",
      jwks: { keys: [] },
      jwks_uri: "https://attacker.example.com/jwks",
      client_credentials_scopes: ["files:write"],
      official: true,
      metadata: { official: true },
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
    expect(out).not.toHaveProperty("official");
    expect(out).not.toHaveProperty("metadata");
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

describe("sanitizeCimdMetadataDocument", () => {
  const CLIENT_ID = "https://connect.example.com/connectors/scl_x";
  const JWKS = "https://connect.example.com/issuers/iss_x/jwks.json";
  const connect = (overrides: Record<string, unknown> = {}) => ({
    client_id: CLIENT_ID,
    client_name: "Vercel Connect",
    redirect_uris: ["https://connect.example.com/callback"],
    token_endpoint_auth_method: "private_key_jwt",
    jwks_uri: JWKS,
    grant_types: ["authorization_code", "client_credentials", "refresh_token"],
    ...overrides,
  });

  it("keeps private_key_jwt + a same-origin https jwks_uri and still drops client_credentials", () => {
    expect(sanitizeCimdMetadataDocument(connect(), CLIENT_ID)).toEqual({
      ...connect(),
      grant_types: ["authorization_code", "refresh_token"],
    });
  });

  it("still strips secrets, inline jwks, skip_consent, and require_pkce on the private_key_jwt path", () => {
    const out = sanitizeCimdMetadataDocument(
      connect({
        client_secret: "forged",
        skip_consent: true,
        trusted: true,
        require_pkce: false,
        client_credentials_scopes: ["files:write"],
        official: true,
      }),
      CLIENT_ID,
    );
    expect(out?.token_endpoint_auth_method).toBe("private_key_jwt");
    expect(out?.jwks_uri).toBe(JWKS);
    for (const field of [
      "client_secret",
      "skip_consent",
      "trusted",
      "require_pkce",
      "client_credentials_scopes",
      "official",
    ]) {
      expect(out, field).not.toHaveProperty(field);
    }
  });

  it.each([
    ["cross-origin", { jwks_uri: "https://keys.other.example/jwks.json" }],
    ["http", { jwks_uri: "http://connect.example.com/issuers/iss_x/jwks.json" }],
    ["different port", { jwks_uri: "https://connect.example.com:8443/jwks.json" }],
    ["subdomain", { jwks_uri: "https://keys.connect.example.com/jwks.json" }],
    ["credentials", { jwks_uri: "https://user:pw@connect.example.com/jwks.json" }],
    ["fragment", { jwks_uri: `${JWKS}#k1` }],
    ["inline jwks", { jwks_uri: undefined, jwks: { keys: [] } }],
    ["jwks and jwks_uri", { jwks: { keys: [] } }],
    ["no key material", { jwks_uri: undefined }],
    ["non-string jwks_uri", { jwks_uri: 42 }],
  ])("falls back to public none for a %s key", (_label, overrides) => {
    const out = sanitizeCimdMetadataDocument(connect(overrides), CLIENT_ID);
    expect(out?.token_endpoint_auth_method).toBe("none");
    expect(out).not.toHaveProperty("jwks_uri");
    expect(out).not.toHaveProperty("jwks");
    expect(out?.grant_types).toEqual(["authorization_code", "refresh_token"]);
  });

  it("binds to the fetched URL's origin, not the document's own client_id claim", () => {
    expect(
      cimdPrivateKeyJwtJwksUri(
        connect({ client_id: "https://keys.other.example/c" }),
        "https://attacker.example/c",
      ),
    ).toBeUndefined();
  });

  it("drops client_credentials even with no authorization_code, and takes the public path", () => {
    const out = sanitizeCimdMetadataDocument(
      connect({ grant_types: ["client_credentials"] }),
      CLIENT_ID,
    );
    expect(out?.grant_types).toEqual([]);
    expect(out?.token_endpoint_auth_method).toBe("none");
    expect(out).not.toHaveProperty("jwks_uri");
  });

  it("takes the public path when grants leave no authorization_code flow", () => {
    const out = sanitizeCimdMetadataDocument(
      connect({ grant_types: ["client_credentials", "refresh_token"] }),
      CLIENT_ID,
    );
    expect(out?.grant_types).toEqual(["refresh_token"]);
    expect(out?.token_endpoint_auth_method).toBe("none");
  });

  it("keeps private_key_jwt when grant_types is omitted (plugin default is authorization_code)", () => {
    const doc = connect();
    delete (doc as Record<string, unknown>).grant_types;
    expect(sanitizeCimdMetadataDocument(doc, CLIENT_ID)).toBeUndefined();
  });

  it("coerces client_secret_* to none, as DCR does", () => {
    const out = sanitizeCimdMetadataDocument(
      connect({ token_endpoint_auth_method: "client_secret_basic" }),
      CLIENT_ID,
    );
    expect(out?.token_endpoint_auth_method).toBe("none");
    expect(out).not.toHaveProperty("jwks_uri");
  });

  it("leaves an already-public document alone", () => {
    expect(
      sanitizeCimdMetadataDocument(
        {
          client_id: CLIENT_ID,
          redirect_uris: ["https://connect.example.com/callback"],
          token_endpoint_auth_method: "none",
        },
        CLIENT_ID,
      ),
    ).toBeUndefined();
  });
});

describe("sanitizeDcrRegistrationBody grant cap", () => {
  it("drops client_credentials from a list with no authorization_code", () => {
    expect(
      sanitizeDcrRegistrationBody({
        token_endpoint_auth_method: "none",
        grant_types: ["client_credentials"],
      }),
    ).toEqual({ token_endpoint_auth_method: "none", grant_types: [] });
  });

  it("leaves a device_code-only list for the plugin to reject", () => {
    const device = "urn:ietf:params:oauth:grant-type:device_code";
    expect(
      sanitizeDcrRegistrationBody({ token_endpoint_auth_method: "none", grant_types: [device] }),
    ).toBeUndefined();
  });
});

describe("dcrRegistrationRejection", () => {
  it("rejects private_key_jwt on open DCR", () => {
    expect(dcrRegistrationRejection({ token_endpoint_auth_method: "private_key_jwt" })).toMatch(
      /Client ID Metadata Document/,
    );
  });

  it.each(["none", "client_secret_basic", "client_secret_post", "client_secret_jwt", undefined])(
    "lets %s through to the coercion pass",
    (method) => {
      expect(dcrRegistrationRejection({ token_endpoint_auth_method: method })).toBeUndefined();
    },
  );
});

describe("cimdClientRowFixups", () => {
  it("pins requirePKCE and clears a leftover jwks_uri once a refreshed client is on none", () => {
    expect(
      cimdClientRowFixups({
        tokenEndpointAuthMethod: "none",
        requirePKCE: null,
        jwksUri: "https://x/jwks",
      }),
    ).toEqual({ requirePKCE: true, jwks: null, jwksUri: null });
  });

  it("keeps the key for a private_key_jwt client and only pins PKCE", () => {
    expect(
      cimdClientRowFixups({
        tokenEndpointAuthMethod: "private_key_jwt",
        requirePKCE: null,
        jwksUri: "https://x/jwks",
      }),
    ).toEqual({ requirePKCE: true });
  });

  it("no-ops when the row is already right", () => {
    expect(
      cimdClientRowFixups({ tokenEndpointAuthMethod: "none", requirePKCE: true, jwksUri: null }),
    ).toBeUndefined();
  });

  it("overrides a stored requirePKCE false", () => {
    expect(cimdClientRowFixups({ tokenEndpointAuthMethod: "none", requirePKCE: false })).toEqual({
      requirePKCE: true,
    });
  });
});
