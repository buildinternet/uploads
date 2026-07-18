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

import { resolveSessionGate, type SessionGateOptions } from "./account-shell";

function element(): HTMLElement {
  return { hidden: false, textContent: "" } as HTMLElement;
}

type TestGate = SessionGateOptions & { who: HTMLElement };

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
  vi.stubGlobal("location", { origin: "http://127.0.0.1:4321" });
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
  vi.unstubAllGlobals();
});

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
