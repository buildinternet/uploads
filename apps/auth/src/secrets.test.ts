import { describe, expect, it } from "vitest";
import { resolveDashApiKey, resolveGitHubCredentials, resolveSigningSecret } from "./secrets";

describe("resolveSigningSecret", () => {
  it("returns the plain BETTER_AUTH_SECRET when set", async () => {
    expect(await resolveSigningSecret({ BETTER_AUTH_SECRET: "plain-secret" })).toBe("plain-secret");
  });

  it("returns null when unset", async () => {
    expect(await resolveSigningSecret({})).toBeNull();
  });

  it("returns null for an empty string", async () => {
    expect(await resolveSigningSecret({ BETTER_AUTH_SECRET: "" })).toBeNull();
  });
});

describe("resolveGitHubCredentials", () => {
  it("returns credentials when both id and secret are set", async () => {
    expect(
      await resolveGitHubCredentials({
        GITHUB_CLIENT_ID: "plain-id",
        GITHUB_CLIENT_SECRET: "plain-secret",
      }),
    ).toEqual({ clientId: "plain-id", clientSecret: "plain-secret" });
  });

  it("gates on both halves — id only is not enough", async () => {
    expect(await resolveGitHubCredentials({ GITHUB_CLIENT_ID: "id" })).toBeNull();
  });

  it("gates on both halves — secret only is not enough", async () => {
    expect(await resolveGitHubCredentials({ GITHUB_CLIENT_SECRET: "secret" })).toBeNull();
  });

  it("returns null with neither set", async () => {
    expect(await resolveGitHubCredentials({})).toBeNull();
  });
});

describe("resolveDashApiKey", () => {
  it("returns the plain BETTER_AUTH_API_KEY when set", async () => {
    expect(await resolveDashApiKey({ BETTER_AUTH_API_KEY: "plain-key" })).toBe("plain-key");
  });

  it("returns null when unset", async () => {
    expect(await resolveDashApiKey({})).toBeNull();
  });
});
