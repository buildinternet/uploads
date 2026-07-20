import { describe, expect, it } from "vitest";
import { appJwt, githubAppConfig, installationForRepo, installationToken } from "./github-app";
import { FakeKv } from "../test/fake-kv";

/** Generate a throwaway RSA key and return its PKCS#8 PEM + public CryptoKey. */
async function testKeyPair(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  const pem = `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

function cfgWith(pem: string) {
  return { appId: "12345", privateKey: pem, homeInstallationId: "777" };
}

function envWith(kv: FakeKv): Env {
  return { GITHUB_CACHE: kv } as unknown as Env;
}

const b64urlJson = (part: string) =>
  JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

describe("githubAppConfig", () => {
  it("returns null unless all three members are set", () => {
    expect(githubAppConfig({} as Env)).toBeNull();
    expect(
      githubAppConfig({ GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY: "k" } as unknown as Env),
    ).toBeNull();
    const full = {
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: "k",
      GITHUB_APP_HOME_INSTALLATION_ID: "2",
    } as unknown as Env;
    expect(githubAppConfig(full)).toEqual({ appId: "1", privateKey: "k", homeInstallationId: "2" });
  });
});

describe("appJwt", () => {
  it("mints a verifiable RS256 JWT with iss/iat/exp", async () => {
    const { pem, publicKey } = await testKeyPair();
    const now = 1_800_000_000_000;
    const jwt = await appJwt(cfgWith(pem), now);
    const [h, p, s] = jwt.split(".");
    expect(b64urlJson(h)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = b64urlJson(p);
    expect(claims.iss).toBe("12345");
    expect(claims.iat).toBe(1_800_000_000 - 60);
    expect(claims.exp).toBe(1_800_000_000 + 540);
    const sig = Uint8Array.from(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      sig,
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });
});

describe("installationForRepo", () => {
  it("fetches, caches the id for 1h, and serves the cache without refetching", async () => {
    const { pem } = await testKeyPair();
    const kv = new FakeKv();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    }) as typeof fetch;
    expect(await installationForRepo(envWith(kv), cfgWith(pem), "o/r", fetchImpl)).toBe(4242);
    expect(kv.store.get("ghinst:o/r")).toEqual({ value: "4242", expirationTtl: 3600 });
    expect(await installationForRepo(envWith(kv), cfgWith(pem), "o/r", fetchImpl)).toBe(4242);
    expect(calls).toBe(1);
  });

  it("caches a 404 as none for 1h", async () => {
    const { pem } = await testKeyPair();
    const kv = new FakeKv();
    const fetchImpl = (async () => new Response("", { status: 404 })) as typeof fetch;
    expect(await installationForRepo(envWith(kv), cfgWith(pem), "o/r", fetchImpl)).toBeNull();
    expect(kv.store.get("ghinst:o/r")).toEqual({ value: "none", expirationTtl: 3600 });
  });

  it("does not cache transient errors", async () => {
    const { pem } = await testKeyPair();
    const kv = new FakeKv();
    const fetchImpl = (async () => new Response("", { status: 502 })) as typeof fetch;
    expect(await installationForRepo(envWith(kv), cfgWith(pem), "o/r", fetchImpl)).toBeNull();
    expect(kv.store.size).toBe(0);
  });
});

describe("installationToken", () => {
  it("mints via POST, caches for 50min, serves the cache", async () => {
    const { pem } = await testKeyPair();
    const kv = new FakeKv();
    let calls = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      expect(String(input)).toBe("https://api.github.com/app/installations/4242/access_tokens");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ token: "ghs_abc" }), { status: 201 });
    }) as typeof fetch;
    expect(await installationToken(envWith(kv), cfgWith(pem), 4242, fetchImpl)).toBe("ghs_abc");
    expect(kv.store.get("ghtok:4242")).toEqual({ value: "ghs_abc", expirationTtl: 3000 });
    expect(await installationToken(envWith(kv), cfgWith(pem), 4242, fetchImpl)).toBe("ghs_abc");
    expect(calls).toBe(1);
  });

  it("returns null (uncached) on a non-201", async () => {
    const { pem } = await testKeyPair();
    const kv = new FakeKv();
    const fetchImpl = (async () => new Response("", { status: 401 })) as typeof fetch;
    expect(await installationToken(envWith(kv), cfgWith(pem), 4242, fetchImpl)).toBeNull();
    expect(kv.store.size).toBe(0);
  });
});
