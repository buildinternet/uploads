import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  signOut: vi.fn(),
  startLocalDemoSession: vi.fn(),
}));

vi.mock("./auth-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-client")>()),
  ...auth,
}));

import { resolveSessionGate, SESSION_CACHE_KEY, type SessionGateOptions } from "./account-shell";
import { markPageLoad, resetPageVisitForTests } from "./page-visit";

function element(): HTMLElement {
  return { hidden: false, textContent: "" } as HTMLElement;
}

type TestGate = SessionGateOptions & { who: HTMLElement; denied: HTMLElement };

function gate(): TestGate {
  return {
    authOrigin: "http://127.0.0.1:8788",
    checking: element(),
    denied: element(),
    unavailable: element(),
    app: element(),
    who: element(),
  };
}

function installBrowser() {
  const values = new Map<string, string>();
  const fakeWindow = {
    dispatchEvent: vi.fn(),
  };
  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("location", {
    origin: "http://127.0.0.1:4321",
    pathname: "/account",
    search: "",
    replace: vi.fn(),
  });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal(
    "CustomEvent",
    class {
      constructor(
        readonly type: string,
        readonly init: { detail: unknown },
      ) {}
    },
  );
  return { values, window: fakeWindow };
}

afterEach(() => {
  auth.getSession.mockReset();
  auth.signOut.mockReset();
  auth.startLocalDemoSession.mockReset();
  resetPageVisitForTests();
  vi.unstubAllGlobals();
});

/** Resolves once queued zero-delay retry timers and their promises have run. */
function flushRetries(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("resolveSessionGate", () => {
  it("shows unavailable when local demo session creation cannot reach Auth", async () => {
    installBrowser();
    const options = gate();
    auth.getSession.mockResolvedValue({ kind: "signed_out" });
    auth.startLocalDemoSession.mockResolvedValue({ kind: "unavailable", reason: "network" });

    await expect(resolveSessionGate(options)).resolves.toBeNull();
    expect(options.unavailable.hidden).toBe(false);
    expect(options.denied.hidden).toBe(true);
    expect(options.app.hidden).toBe(true);
  });

  it("keeps a role-mismatched session denied without starting the demo", async () => {
    installBrowser();
    const options = { ...gate(), requireRole: "admin" };
    auth.getSession.mockResolvedValue({
      kind: "signed_in",
      session: {
        session: {},
        user: { id: "user", email: "user@example.com", name: "User", role: "user" },
      },
    });

    await expect(resolveSessionGate(options)).resolves.toBeNull();
    expect(auth.startLocalDemoSession).not.toHaveBeenCalled();
    expect(options.denied.hidden).toBe(false);
    expect(options.app.hidden).toBe(true);
  });

  it("rechecks, caches, and publishes the normal session created by the local demo", async () => {
    const { values, window } = installBrowser();
    const options = gate();
    const session = {
      session: {},
      user: { id: "demo", email: "dev-demo@uploads.local", name: "Local demo", role: "user" },
    };
    auth.getSession.mockResolvedValueOnce({ kind: "signed_out" }).mockResolvedValueOnce({
      kind: "signed_in",
      session,
    });
    auth.startLocalDemoSession.mockResolvedValue({ kind: "started" });

    await expect(resolveSessionGate(options)).resolves.toEqual(session);
    expect(auth.getSession).toHaveBeenCalledTimes(2);
    expect(auth.startLocalDemoSession).toHaveBeenCalledWith(
      "http://127.0.0.1:8788",
      "http://127.0.0.1:4321",
    );
    expect(values.get("uploads:sessionUser")).toContain(session.user.email);
    expect(options.app.hidden).toBe(false);
    // Optional #who email paint (legacy); avatar menu no longer needs it.
    expect(options.who.textContent).toBe(session.user.email);
    expect(window.dispatchEvent).toHaveBeenCalledOnce();
  });

  it("sends a signed-out visit to login with the current path as callbackURL", async () => {
    const replace = vi.fn();
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    vi.stubGlobal("location", {
      origin: "https://uploads.sh",
      pathname: "/account/workspaces/acme/screenshots",
      search: "?path=/settings",
      replace,
    });
    vi.stubGlobal("sessionStorage", {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => undefined,
    });
    const options = gate();
    auth.getSession.mockResolvedValue({ kind: "signed_out" });
    auth.startLocalDemoSession.mockResolvedValue({ kind: "not_enabled" });

    await expect(resolveSessionGate(options)).resolves.toBeNull();
    expect(replace).toHaveBeenCalledWith(
      "/login?callbackURL=%2Faccount%2Fworkspaces%2Facme%2Fscreenshots%3Fpath%3D%2Fsettings",
    );
    expect(options.denied.hidden).toBe(true);
    expect(options.app.hidden).toBe(true);
  });

  it("keeps the shell visible on auth-unavailable when an identity is cached", async () => {
    const { values } = installBrowser();
    values.set(
      SESSION_CACHE_KEY,
      JSON.stringify({ id: "user", email: "user@example.com", name: "User", role: "user" }),
    );
    markPageLoad();
    const options = { ...gate(), retryDelaysMs: [0] };
    const session = {
      session: {},
      user: { id: "user", email: "user@example.com", name: "User", role: "user" },
    };
    auth.getSession
      .mockResolvedValueOnce({ kind: "unavailable", reason: "server" })
      .mockResolvedValueOnce({ kind: "signed_in", session });

    await expect(resolveSessionGate(options)).resolves.toBeNull();
    expect(options.app.hidden).toBe(false);
    expect(options.unavailable.hidden).toBe(true);

    await flushRetries();
    expect(auth.getSession).toHaveBeenCalledTimes(2);
    expect(options.app.hidden).toBe(false);
    expect(values.get(SESSION_CACHE_KEY)).toContain("user@example.com");
  });

  it("keeps the shell visible when every background retry stays unavailable", async () => {
    const { values } = installBrowser();
    values.set(
      SESSION_CACHE_KEY,
      JSON.stringify({ id: "user", email: "user@example.com", name: "User", role: "user" }),
    );
    markPageLoad();
    const options = { ...gate(), retryDelaysMs: [0, 0] };
    auth.getSession.mockResolvedValue({ kind: "unavailable", reason: "server" });

    await expect(resolveSessionGate(options)).resolves.toBeNull();
    await flushRetries();
    await flushRetries();
    expect(auth.getSession).toHaveBeenCalledTimes(3);
    expect(options.app.hidden).toBe(false);
    expect(options.unavailable.hidden).toBe(true);
  });

  it("still blocks on auth-unavailable when no identity is known", async () => {
    installBrowser();
    const options = gate();
    auth.getSession.mockResolvedValue({ kind: "unavailable", reason: "server" });

    await expect(resolveSessionGate(options)).resolves.toBeNull();
    expect(options.unavailable.hidden).toBe(false);
    expect(options.app.hidden).toBe(true);
  });

  it("redirects to login when a background retry finds the session signed out", async () => {
    const replace = vi.fn();
    const { values } = installBrowser();
    vi.stubGlobal("location", {
      origin: "https://uploads.sh",
      pathname: "/account",
      search: "",
      replace,
    });
    values.set(
      SESSION_CACHE_KEY,
      JSON.stringify({ id: "user", email: "user@example.com", name: "User", role: "user" }),
    );
    markPageLoad();
    const options = { ...gate(), retryDelaysMs: [0] };
    auth.getSession
      .mockResolvedValueOnce({ kind: "unavailable", reason: "server" })
      .mockResolvedValueOnce({ kind: "signed_out" });

    await expect(resolveSessionGate(options)).resolves.toBeNull();
    await flushRetries();
    expect(replace).toHaveBeenCalledWith("/login?callbackURL=%2Faccount");
    expect(values.has(SESSION_CACHE_KEY)).toBe(false);
  });

  it("shows the app without a who node when the header owns session UI", async () => {
    installBrowser();
    const options = {
      authOrigin: "http://127.0.0.1:8788",
      checking: element(),
      denied: element(),
      unavailable: element(),
      app: element(),
    };
    auth.getSession.mockResolvedValue({
      kind: "signed_in",
      session: {
        session: {},
        user: { id: "user", email: "user@example.com", name: "User", role: "user" },
      },
    });

    await expect(resolveSessionGate(options)).resolves.not.toBeNull();
    expect(options.app.hidden).toBe(false);
    expect(options.checking.hidden).toBe(true);
  });
});
