import { describe, expect, it } from "vitest";
import {
  resolveDashApiKey,
  resolveGitHubCredentials,
  resolveSecret,
  resolveSigningSecret,
  type SecretsStoreSecret,
} from "./secrets";

function store(value: string): SecretsStoreSecret {
  return { get: async () => value };
}

function failingStore(): SecretsStoreSecret {
  return {
    get: async () => {
      throw new Error("store unreachable");
    },
  };
}

describe("resolveSecret", () => {
  it("returns a plain string as-is", async () => {
    expect(await resolveSecret("plain")).toBe("plain");
  });

  it("returns null for undefined", async () => {
    expect(await resolveSecret(undefined)).toBeNull();
  });

  it("resolves a Secrets Store binding", async () => {
    expect(await resolveSecret(store("from-store"))).toBe("from-store");
  });

  it("treats an empty store value as unresolved", async () => {
    expect(await resolveSecret(store(""))).toBeNull();
  });

  it("swallows store failures rather than throwing", async () => {
    await expect(resolveSecret(failingStore())).resolves.toBeNull();
  });
});

describe("resolveSigningSecret", () => {
  it("prefers the plain BETTER_AUTH_SECRET over the store fallback", async () => {
    expect(
      await resolveSigningSecret({
        BETTER_AUTH_SECRET: "plain-secret",
        UPL_BETTER_AUTH_SECRET: store("store-secret"),
      }),
    ).toBe("plain-secret");
  });

  it("falls back to the store when the plain secret is unset", async () => {
    expect(
      await resolveSigningSecret({
        UPL_BETTER_AUTH_SECRET: store("store-secret"),
      }),
    ).toBe("store-secret");
  });

  it("falls back to the store when the plain secret is empty", async () => {
    expect(
      await resolveSigningSecret({
        BETTER_AUTH_SECRET: "",
        UPL_BETTER_AUTH_SECRET: store("store-secret"),
      }),
    ).toBe("store-secret");
  });

  it("returns null when the store fails and no plain secret is set", async () => {
    expect(
      await resolveSigningSecret({
        UPL_BETTER_AUTH_SECRET: failingStore(),
      }),
    ).toBeNull();
  });

  it("returns null when nothing resolves", async () => {
    expect(await resolveSigningSecret({})).toBeNull();
  });
});

describe("resolveGitHubCredentials", () => {
  it("returns credentials when both id and secret resolve from the store", async () => {
    expect(
      await resolveGitHubCredentials({
        UPL_GITHUB_CLIENT_ID: store("id"),
        UPL_GITHUB_CLIENT_SECRET: store("secret"),
      }),
    ).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("prefers plain vars over the store, per half", async () => {
    expect(
      await resolveGitHubCredentials({
        GITHUB_CLIENT_ID: "plain-id",
        UPL_GITHUB_CLIENT_ID: store("store-id"),
        UPL_GITHUB_CLIENT_SECRET: store("store-secret"),
      }),
    ).toEqual({ clientId: "plain-id", clientSecret: "store-secret" });
  });

  it("gates on both halves — id only is not enough", async () => {
    expect(
      await resolveGitHubCredentials({
        UPL_GITHUB_CLIENT_ID: store("id"),
      }),
    ).toBeNull();
  });

  it("gates on both halves — secret only is not enough", async () => {
    expect(
      await resolveGitHubCredentials({
        UPL_GITHUB_CLIENT_SECRET: store("secret"),
      }),
    ).toBeNull();
  });

  it("resolves entirely from plain vars when the store is unset", async () => {
    expect(
      await resolveGitHubCredentials({
        GITHUB_CLIENT_ID: "plain-id",
        GITHUB_CLIENT_SECRET: "plain-secret",
      }),
    ).toEqual({ clientId: "plain-id", clientSecret: "plain-secret" });
  });

  it("returns null with neither plain vars nor store set", async () => {
    expect(await resolveGitHubCredentials({})).toBeNull();
  });
});

describe("resolveDashApiKey", () => {
  it("prefers the plain BETTER_AUTH_API_KEY, falls back to the store, else null", async () => {
    expect(
      await resolveDashApiKey({
        BETTER_AUTH_API_KEY: "plain-key",
        UPL_BETTER_AUTH_API_KEY: store("store-key"),
      }),
    ).toBe("plain-key");
    expect(
      await resolveDashApiKey({
        UPL_BETTER_AUTH_API_KEY: store("store-key"),
      }),
    ).toBe("store-key");
    expect(
      await resolveDashApiKey({
        UPL_BETTER_AUTH_API_KEY: failingStore(),
      }),
    ).toBeNull();
    expect(await resolveDashApiKey({})).toBeNull();
  });
});
