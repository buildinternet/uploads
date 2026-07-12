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
  it("prefers the Secrets Store binding", async () => {
    expect(
      await resolveSigningSecret({
        UPL_BETTER_AUTH_SECRET: store("store-secret"),
        BETTER_AUTH_SECRET_DEV: "dev-secret",
      }),
    ).toBe("store-secret");
  });

  it("falls back to BETTER_AUTH_SECRET_DEV when the store is empty", async () => {
    expect(
      await resolveSigningSecret({
        UPL_BETTER_AUTH_SECRET: store(""),
        BETTER_AUTH_SECRET_DEV: "dev-secret",
      }),
    ).toBe("dev-secret");
  });

  it("falls back to BETTER_AUTH_SECRET_DEV when the store fails", async () => {
    expect(
      await resolveSigningSecret({
        UPL_BETTER_AUTH_SECRET: failingStore(),
        BETTER_AUTH_SECRET_DEV: "dev-secret",
      }),
    ).toBe("dev-secret");
  });

  it("returns null when nothing resolves", async () => {
    expect(await resolveSigningSecret({})).toBeNull();
  });
});

describe("resolveGitHubCredentials", () => {
  it("returns credentials when both id and secret resolve", async () => {
    expect(
      await resolveGitHubCredentials({
        UPL_GITHUB_CLIENT_ID: store("id"),
        UPL_GITHUB_CLIENT_SECRET: store("secret"),
      }),
    ).toEqual({ clientId: "id", clientSecret: "secret" });
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

  it("falls back to dev plain vars when the store is unpopulated", async () => {
    expect(
      await resolveGitHubCredentials({
        GITHUB_CLIENT_ID: "dev-id",
        GITHUB_CLIENT_SECRET: "dev-secret",
      }),
    ).toEqual({ clientId: "dev-id", clientSecret: "dev-secret" });
  });

  it("returns null with neither store nor dev vars set", async () => {
    expect(await resolveGitHubCredentials({})).toBeNull();
  });
});

describe("resolveDashApiKey", () => {
  it("prefers the store, falls back to BETTER_AUTH_API_KEY, else null", async () => {
    expect(
      await resolveDashApiKey({
        UPL_BETTER_AUTH_API_KEY: store("store-key"),
        BETTER_AUTH_API_KEY: "dev-key",
      }),
    ).toBe("store-key");
    expect(
      await resolveDashApiKey({
        UPL_BETTER_AUTH_API_KEY: failingStore(),
        BETTER_AUTH_API_KEY: "dev-key",
      }),
    ).toBe("dev-key");
    expect(await resolveDashApiKey({})).toBeNull();
  });
});
