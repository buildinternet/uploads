import { describe, expect, it } from "vitest";
import {
  oauthClientIdFromAuthorizationCode,
  oauthClientIdFromConsentBody,
  oauthClientIdFromQuery,
  restrictAuthorizationCodeValue,
  restrictOAuthConsentBody,
  restrictOAuthQueryScopes,
} from "./oauth-grant-scopes";

const DEFAULT_SCOPES = ["files:read", "files:write"] as const;
const SELF_REGISTERED = ["files:read", "files:write", "files:delete"] as const;
const KITCHEN_SINK = "files:read files:write files:delete openid profile admin";

describe("restrictOAuthQueryScopes", () => {
  it("drops unknown scope ids rather than failing the request", () => {
    expect(
      restrictOAuthQueryScopes({ client_id: "c1", scope: KITCHEN_SINK }, SELF_REGISTERED),
    ).toEqual({
      client_id: "c1",
      scope: "files:read files:write files:delete",
    });
  });

  it("downscopes to the client's registered list when files:delete is not allowed", () => {
    expect(restrictOAuthQueryScopes({ scope: KITCHEN_SINK }, DEFAULT_SCOPES)).toEqual({
      scope: "files:read files:write",
    });
  });

  it("leaves the query alone when every requested id is already allowed", () => {
    expect(
      restrictOAuthQueryScopes({ scope: "files:read files:write" }, SELF_REGISTERED),
    ).toBeUndefined();
  });

  it("returns undefined when there is no scope to rewrite", () => {
    expect(restrictOAuthQueryScopes({ client_id: "c1" }, SELF_REGISTERED)).toBeUndefined();
    expect(restrictOAuthQueryScopes(undefined, SELF_REGISTERED)).toBeUndefined();
  });

  it("rewrites to empty when nothing grantable remains", () => {
    expect(restrictOAuthQueryScopes({ scope: "openid admin" }, SELF_REGISTERED)).toEqual({
      scope: "",
    });
  });
});

describe("restrictOAuthConsentBody", () => {
  it("strips unknown ids from an explicit body.scope", () => {
    expect(
      restrictOAuthConsentBody({ accept: true, scope: KITCHEN_SINK }, SELF_REGISTERED),
    ).toEqual({
      accept: true,
      scope: "files:read files:write files:delete",
    });
  });

  it("injects a filtered scope from oauth_query when the body omitted one", () => {
    const oauth_query = "client_id=c1&scope=files%3Aread+openid+files%3Awrite&sig=abc";
    expect(restrictOAuthConsentBody({ accept: true, oauth_query }, DEFAULT_SCOPES)).toEqual({
      accept: true,
      oauth_query,
      scope: "files:read files:write",
    });
  });

  it("does not invent a scope when oauth_query has none", () => {
    expect(
      restrictOAuthConsentBody(
        { accept: true, oauth_query: "client_id=c1&sig=abc" },
        SELF_REGISTERED,
      ),
    ).toBeUndefined();
  });
});

describe("restrictAuthorizationCodeValue", () => {
  it("rewrites query.scope inside an authorization_code blob", () => {
    const value = JSON.stringify({
      type: "authorization_code",
      userId: "u1",
      query: { client_id: "c1", scope: KITCHEN_SINK },
    });
    const next = restrictAuthorizationCodeValue(value, SELF_REGISTERED);
    expect(JSON.parse(next ?? "")).toEqual({
      type: "authorization_code",
      userId: "u1",
      query: { client_id: "c1", scope: "files:read files:write files:delete" },
    });
  });

  it("leaves non-authorization_code values alone", () => {
    expect(
      restrictAuthorizationCodeValue(
        JSON.stringify({ type: "email", value: "x" }),
        SELF_REGISTERED,
      ),
    ).toBeUndefined();
    expect(restrictAuthorizationCodeValue("not-json", SELF_REGISTERED)).toBeUndefined();
    expect(restrictAuthorizationCodeValue(undefined, SELF_REGISTERED)).toBeUndefined();
  });
});

describe("client_id extractors", () => {
  it("reads client_id from an authorize query", () => {
    expect(oauthClientIdFromQuery({ client_id: "https://client.example/meta.json" })).toBe(
      "https://client.example/meta.json",
    );
    expect(oauthClientIdFromQuery({})).toBeUndefined();
  });

  it("reads client_id from a consent body or signed oauth_query", () => {
    expect(oauthClientIdFromConsentBody({ client_id: "direct" })).toBe("direct");
    expect(
      oauthClientIdFromConsentBody({ oauth_query: "client_id=from-query&scope=files%3Aread" }),
    ).toBe("from-query");
  });

  it("reads client_id from an authorization_code blob", () => {
    const value = JSON.stringify({
      type: "authorization_code",
      query: { client_id: "c1", scope: "files:read" },
    });
    expect(oauthClientIdFromAuthorizationCode(value)).toBe("c1");
    expect(oauthClientIdFromAuthorizationCode("nope")).toBeUndefined();
  });
});
