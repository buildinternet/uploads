import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatDeviceScope,
  parseDeviceScope,
  resolveAuthUrl,
  resolveEnrollmentCode,
  runLogin,
  validateEnrollmentCode,
  type DeviceLoginIo,
} from "../src/commands/login.js";
import {
  inviteMagicLink,
  invitePageUrl,
  parseScopes,
  runAdmin,
} from "../src/commands/admin-enrollment.js";
import { parseCommandArgs } from "../src/cli-args.js";
import { loadConfigFile, writeConfigKeys } from "../src/config-file.js";

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of [
    "UPLOADS_ENROLLMENT_CODE",
    "UPLOADS_TOKEN",
    "ADMIN_TOKEN",
    "UPLOADS_ADMIN_TOKEN",
  ])
    delete process.env[key];
});

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function captureOutput() {
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((value: string | Uint8Array) => {
    out += String(value);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((value: string | Uint8Array) => {
    err += String(value);
    return true;
  }) as typeof process.stderr.write);
  return { out: () => out, err: () => err };
}

describe("login enrollment input", () => {
  it("accepts and trims a high-entropy enrollment code", () => {
    const code = "upe_abcdefghijklmnopqrstuvwxyz012345";
    expect(validateEnrollmentCode(`  ${code}\n`)).toBe(code);
  });

  it.each(["", "123456", "upe_short", "upe_has whitespace 12345678901234567890"])(
    "rejects malformed code %j",
    (code) => expect(() => validateEnrollmentCode(code)).toThrow("invalid enrollment code"),
  );

  it("allows explicit stdin with --non-interactive", async () => {
    const code = "upe_abcdefghijklmnopqrstuvwxyz012345";
    await expect(
      resolveEnrollmentCode(parseCommandArgs(["--code-stdin", "--non-interactive"]), {
        isTTY: false,
        readLine: async () => code,
        hiddenPrompt: async () => "unused",
      }),
    ).resolves.toBe(code);
  });

  it("uses UPLOADS_ENROLLMENT_CODE without stdin", async () => {
    process.env.UPLOADS_ENROLLMENT_CODE = "upe_abcdefghijklmnopqrstuvwxyz012345";
    const readLine = vi.fn(async () => "unused");
    await expect(
      resolveEnrollmentCode(parseCommandArgs(["--non-interactive"]), {
        isTTY: false,
        readLine,
        hiddenPrompt: async () => "unused",
      }),
    ).resolves.toBe(process.env.UPLOADS_ENROLLMENT_CODE);
    expect(readLine).not.toHaveBeenCalled();
  });
});

describe("runLogin", () => {
  it("exchanges, writes, verifies, and redacts the raw token", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const token = "up_default_abcdefghijklmnopqrstuvwxyz";
    process.env.UPLOADS_ENROLLMENT_CODE = "upe_abcdefghijklmnopqrstuvwxyz012345";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ workspace: "default", token }, 201))
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({ items: [], cursor: null }));
    const output = captureOutput();
    expect(await runLogin(["--non-interactive", "--path", path], { json: true })).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(loadConfigFile(path).UPLOADS_TOKEN).toBe(token);
    expect(output.out() + output.err()).not.toContain(token);
    expect(output.out()).toContain("set (up_default_");
  });

  it("preflights existing config before exchange", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    writeConfigKeys(path, { UPLOADS_TOKEN: "up_default_existingexistingexisting" });
    process.env.UPLOADS_ENROLLMENT_CODE = "upe_abcdefghijklmnopqrstuvwxyz012345";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(runLogin(["--non-interactive", "--path", path], {})).rejects.toThrow(
      "credentials already exist",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supports --no-check", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    process.env.UPLOADS_ENROLLMENT_CODE = "upe_abcdefghijklmnopqrstuvwxyz012345";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({ workspace: "default", token: "up_default_abcdefghijklmnopqrstuvwxyz" }, 201),
      );
    captureOutput();
    expect(
      await runLogin(["--non-interactive", "--no-check", "--path", path], { json: true }),
    ).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed exchange response", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    process.env.UPLOADS_ENROLLMENT_CODE = "upe_abcdefghijklmnopqrstuvwxyz012345";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      response({ workspace: "other", token: "up_default_abcdefghijklmnopqrstuvwxyz" }, 201),
    );
    await expect(runLogin(["--non-interactive", "--path", path], {})).rejects.toThrow(
      "invalid credentials",
    );
  });
});

describe("resolveAuthUrl", () => {
  it("prefers an explicit --auth-url", () => {
    expect(resolveAuthUrl(parseCommandArgs(["--auth-url", "http://127.0.0.1:8788/"]), "x")).toBe(
      "http://127.0.0.1:8788",
    );
  });

  it("swaps an api. host label for auth.", () => {
    expect(resolveAuthUrl(parseCommandArgs([]), "https://api.uploads.sh")).toBe(
      "https://auth.uploads.sh",
    );
  });

  it("falls back to the production default for non-api hosts", () => {
    expect(resolveAuthUrl(parseCommandArgs([]), "http://localhost:8787")).toBe(
      "https://auth.uploads.sh",
    );
  });
});

describe("runLogin device flow", () => {
  const silentIo: DeviceLoginIo = {
    sleep: async () => {},
    now: () => Date.now(),
    openUrl: () => {},
    write: () => {},
    isTTY: false,
    promptWorkspaceName: async () => "",
  };

  const deviceCode = (over: Record<string, unknown> = {}) =>
    response({
      device_code: "dev-123",
      user_code: "ABCD-EFGH",
      verification_uri: "https://uploads.sh/device",
      verification_uri_complete: "https://uploads.sh/device?user_code=ABCD-EFGH",
      expires_in: 900,
      interval: 5,
      ...over,
    });

  it("runs code → poll → mint, then writes and verifies", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const token = "up_acme_abcdefghijklmnopqrstuvwxyz";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode()) // device/code
      .mockResolvedValueOnce(response({ error: "authorization_pending" }, 400)) // poll 1
      .mockResolvedValueOnce(
        response({ access_token: "sess-tok", token_type: "Bearer", expires_in: 3600, scope: "" }),
      ) // poll 2
      .mockResolvedValueOnce(response({ workspaces: [{ workspace: "acme", role: "member" }] })) // GET /v1/tokens
      .mockResolvedValueOnce(
        response(
          {
            token,
            workspace: "acme",
            scopes: ["files:read", "files:write"],
            label: "host",
            expiresAt: null,
          },
          201,
        ),
      ) // POST /v1/tokens
      .mockResolvedValueOnce(response({ ok: true })) // doctor health
      .mockResolvedValueOnce(response({ items: [], cursor: null })); // doctor list
    const output = captureOutput();

    expect(await runLogin(["--path", path], { json: true }, false, silentIo)).toBe(0);

    // The bearer session token is presented to /v1/tokens (GET + POST).
    const mintCall = fetchMock.mock.calls.find(
      (c) => String(c[0]).endsWith("/v1/tokens") && (c[1] as RequestInit)?.method === "POST",
    );
    expect((mintCall![1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer sess-tok",
    });
    // Interactive login requests the full file-scope set (including delete)
    // by default — the server's conservative read+write default is for
    // automation mints, not the user's own credential.
    expect(JSON.parse(String((mintCall![1] as RequestInit).body))).toMatchObject({
      grants: [{ workspace: "acme", scopes: ["files:read", "files:write", "files:delete"] }],
    });
    expect(loadConfigFile(path).UPLOADS_TOKEN).toBe(token);
    expect(loadConfigFile(path).UPLOADS_WORKSPACE).toBe("acme");
    expect(output.out() + output.err()).not.toContain(token);
  });

  it("uses --workspace directly and skips the workspace lookup", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const token = "up_acme_abcdefghijklmnopqrstuvwxyz";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValueOnce(
        response({ access_token: "sess-tok", token_type: "Bearer", expires_in: 3600, scope: "" }),
      )
      .mockResolvedValueOnce(
        response(
          { token, workspace: "acme", scopes: ["files:read"], label: "host", expiresAt: null },
          201,
        ),
      );
    captureOutput();

    expect(
      await runLogin(
        ["--path", path, "--workspace", "acme", "--no-check"],
        { json: true },
        false,
        silentIo,
      ),
    ).toBe(0);
    // No GET /v1/tokens listing call happened.
    expect(
      fetchMock.mock.calls.some(
        (c) => String(c[0]).endsWith("/v1/tokens") && (c[1] as RequestInit)?.method !== "POST",
      ),
    ).toBe(false);
  });

  it("errors when the account has multiple workspaces and none is chosen", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValueOnce(
        response({ access_token: "sess-tok", token_type: "Bearer", expires_in: 3600, scope: "" }),
      )
      .mockResolvedValueOnce(
        response({
          workspaces: [
            { workspace: "acme", role: "member" },
            { workspace: "beta", role: "member" },
          ],
        }),
      );
    captureOutput();
    await expect(
      runLogin(["--path", path, "--no-check"], { json: true }, false, silentIo),
    ).rejects.toThrow("multiple workspaces");
  });

  it("errors actionably when the account has zero workspaces and is non-interactive", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValueOnce(
        response({ access_token: "sess-tok", token_type: "Bearer", expires_in: 3600, scope: "" }),
      )
      .mockResolvedValueOnce(response({ workspaces: [] }));
    captureOutput();
    await expect(
      runLogin(["--path", path, "--no-check"], { json: true }, false, {
        ...silentIo,
        isTTY: false,
      }),
    ).rejects.toThrow(/no workspace access yet.*--workspace <name> --create.*uploads login/s);
  });

  it("provisions the workspace with --workspace --create when the account lacks it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const token = "up_newteam_abcdefghijklmnopqrstuvwxyz";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValueOnce(
        response({ access_token: "sess-tok", token_type: "Bearer", expires_in: 3600, scope: "" }),
      )
      .mockResolvedValueOnce(response({ workspaces: [] })) // GET /v1/tokens
      .mockResolvedValueOnce(
        response(
          {
            workspace: {
              name: "newteam",
              publicBaseUrl: "https://storage.uploads.sh/newteam",
              selfServe: true,
            },
          },
          201,
        ),
      ) // POST /v1/workspaces
      .mockResolvedValueOnce(
        response(
          {
            token,
            workspace: "newteam",
            scopes: ["files:read", "files:write"],
            label: "host",
            expiresAt: null,
          },
          201,
        ),
      ); // POST /v1/tokens

    // Non-interactive io: --create must work without any prompt.
    expect(
      await runLogin(
        ["--path", path, "--workspace", "newteam", "--create", "--no-check"],
        { json: true },
        false,
        { ...silentIo, isTTY: false },
      ),
    ).toBe(0);

    const createCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/v1/workspaces"));
    expect(createCall).toBeTruthy();
    expect(JSON.parse(String((createCall![1] as RequestInit).body))).toEqual({ name: "newteam" });
    expect(loadConfigFile(path).UPLOADS_WORKSPACE).toBe("newteam");
  });

  it("skips provisioning with --create when the workspace already exists", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const token = "up_acme_abcdefghijklmnopqrstuvwxyz";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValueOnce(
        response({ access_token: "sess-tok", token_type: "Bearer", expires_in: 3600, scope: "" }),
      )
      .mockResolvedValueOnce(response({ workspaces: [{ workspace: "acme", role: "owner" }] }))
      .mockResolvedValueOnce(
        response(
          {
            token,
            workspace: "acme",
            scopes: ["files:read", "files:write"],
            label: "host",
            expiresAt: null,
          },
          201,
        ),
      ); // POST /v1/tokens

    expect(
      await runLogin(
        ["--path", path, "--workspace", "acme", "--create", "--no-check"],
        { json: true },
        false,
        silentIo,
      ),
    ).toBe(0);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/v1/workspaces"))).toBe(false);
  });

  it("rejects --create without --workspace", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      runLogin(["--path", path, "--create"], { json: true }, false, silentIo),
    ).rejects.toThrow(/--create requires --workspace/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects --create combined with an enrollment code", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      runLogin(
        ["--path", path, "--workspace", "acme", "--create", "--code", `upe_${"a".repeat(24)}`],
        { json: true },
        false,
        silentIo,
      ),
    ).rejects.toThrow(/--create is device-flow only/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prompts to create a workspace when zero exist and interactive, then mints for it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const token = "up_newteam_abcdefghijklmnopqrstuvwxyz";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValueOnce(
        response({ access_token: "sess-tok", token_type: "Bearer", expires_in: 3600, scope: "" }),
      )
      .mockResolvedValueOnce(response({ workspaces: [] })) // GET /v1/tokens
      .mockResolvedValueOnce(
        response(
          {
            workspace: {
              name: "newteam",
              publicBaseUrl: "https://storage.uploads.sh/newteam",
              selfServe: true,
            },
          },
          201,
        ),
      ) // POST /v1/workspaces
      .mockResolvedValueOnce(
        response(
          {
            token,
            workspace: "newteam",
            scopes: ["files:read", "files:write"],
            label: "host",
            expiresAt: null,
          },
          201,
        ),
      ); // POST /v1/tokens
    captureOutput();

    expect(
      await runLogin(["--path", path, "--no-check"], { json: true }, false, {
        ...silentIo,
        isTTY: true,
        promptWorkspaceName: async () => "newteam",
      }),
    ).toBe(0);

    const createCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/v1/workspaces"));
    expect(createCall).toBeTruthy();
    expect(JSON.parse(String((createCall![1] as RequestInit).body))).toEqual({
      name: "newteam",
    });
    expect(loadConfigFile(path).UPLOADS_WORKSPACE).toBe("newteam");
    expect(loadConfigFile(path).UPLOADS_TOKEN).toBe(token);
  });

  it("points at account/profile when workspace creation requires GitHub", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValueOnce(
        response({ access_token: "sess-tok", token_type: "Bearer", expires_in: 3600, scope: "" }),
      )
      .mockResolvedValueOnce(response({ workspaces: [] })) // GET /v1/tokens
      .mockResolvedValueOnce(
        response({ error: { code: "github_required", message: "GitHub account required" } }, 403),
      ); // POST /v1/workspaces
    captureOutput();

    await expect(
      runLogin(["--path", path, "--no-check"], { json: true }, false, {
        ...silentIo,
        isTTY: true,
        promptWorkspaceName: async () => "newteam",
      }),
    ).rejects.toThrow(/linked GitHub account.*uploads\.sh\/account\/profile.*uploads login/s);
  });

  it("fails fast (no polling) in non-interactive mode with no enrollment code", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      runLogin(["--path", path, "--non-interactive"], { json: true }, false, silentIo),
    ).rejects.toThrow(/device login requires a browser/);
    // Never hit the network — no device/code request was made.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops when the user denies the request", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValueOnce(response({ error: "access_denied" }, 400));
    captureOutput();
    await expect(runLogin(["--path", path], { json: true }, false, silentIo)).rejects.toThrow(
      "denied",
    );
  });

  it("backs off on slow_down and keeps polling", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const token = "up_acme_abcdefghijklmnopqrstuvwxyz";
    let slept = 0;
    const io: DeviceLoginIo = {
      ...silentIo,
      sleep: async (ms) => {
        slept = ms;
      },
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode({ interval: 5 }))
      .mockResolvedValueOnce(response({ error: "slow_down" }, 400))
      .mockResolvedValueOnce(
        response({ access_token: "sess-tok", token_type: "Bearer", expires_in: 3600, scope: "" }),
      )
      .mockResolvedValueOnce(
        response(
          { token, workspace: "acme", scopes: ["files:read"], label: "h", expiresAt: null },
          201,
        ),
      );
    captureOutput();
    expect(
      await runLogin(
        ["--path", path, "--workspace", "acme", "--no-check"],
        { json: true },
        false,
        io,
      ),
    ).toBe(0);
    // interval started at 5s and grew by 5s after slow_down.
    expect(slept).toBe(10000);
  });
});

describe("device scope vocabulary", () => {
  it("formats only when a workspace was requested", () => {
    expect(formatDeviceScope(undefined, false)).toBeUndefined();
    expect(formatDeviceScope(undefined, true)).toBeUndefined();
    expect(formatDeviceScope("acme", false)).toBe("workspace:acme");
    expect(formatDeviceScope("acme", true)).toBe("workspace:acme create");
  });

  it("round-trips through parse", () => {
    expect(parseDeviceScope(formatDeviceScope("acme", true))).toEqual({
      workspace: "acme",
      create: true,
    });
    expect(parseDeviceScope("workspace:acme")).toEqual({ workspace: "acme", create: false });
    expect(parseDeviceScope("")).toEqual({ workspace: undefined, create: false });
    expect(parseDeviceScope(undefined)).toEqual({ workspace: undefined, create: false });
  });
});

describe("runLogin device flow — browser workspace selection", () => {
  const silentIo: DeviceLoginIo = {
    sleep: async () => {},
    now: () => Date.now(),
    openUrl: () => {},
    write: () => {},
    isTTY: false,
    promptWorkspaceName: async () => "",
  };

  const deviceCode = (over: Record<string, unknown> = {}) =>
    response({
      device_code: "dev-123",
      user_code: "ABCD-EFGH",
      verification_uri: "https://uploads.sh/device",
      verification_uri_complete: "https://uploads.sh/device?user_code=ABCD-EFGH",
      expires_in: 900,
      interval: 5,
      ...over,
    });

  it("sends the requested workspace as a device-code scope", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const token = "up_acme_abcdefghijklmnopqrstuvwxyz";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValueOnce(
        response({
          access_token: "sess-tok",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "workspace:acme",
        }),
      )
      .mockResolvedValueOnce(
        response(
          { token, workspace: "acme", scopes: ["files:read"], label: "host", expiresAt: null },
          201,
        ),
      );
    captureOutput();

    expect(
      await runLogin(
        ["--path", path, "--workspace", "acme", "--no-check"],
        { json: true },
        false,
        silentIo,
      ),
    ).toBe(0);

    const codeCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/device/code"));
    expect(JSON.parse(String((codeCall![1] as RequestInit).body))).toMatchObject({
      client_id: "uploads-cli",
      scope: "workspace:acme",
    });
  });

  it("mints for the workspace the browser chose, overriding --workspace", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const token = "up_beta_abcdefghijklmnopqrstuvwxyz";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValueOnce(
        response({
          access_token: "sess-tok",
          token_type: "Bearer",
          expires_in: 3600,
          // The approval page rewrote the row: the user picked `beta`.
          scope: "workspace:beta",
        }),
      )
      .mockResolvedValueOnce(
        response(
          { token, workspace: "beta", scopes: ["files:read"], label: "host", expiresAt: null },
          201,
        ),
      );
    captureOutput();

    expect(
      await runLogin(
        ["--path", path, "--workspace", "acme", "--no-check"],
        { json: true },
        false,
        silentIo,
      ),
    ).toBe(0);

    const mintCall = fetchMock.mock.calls.find(
      (c) => String(c[0]).endsWith("/v1/tokens") && (c[1] as RequestInit)?.method === "POST",
    );
    expect(JSON.parse(String((mintCall![1] as RequestInit).body))).toMatchObject({
      grants: [{ workspace: "beta" }],
    });
    expect(loadConfigFile(path).UPLOADS_WORKSPACE).toBe("beta");
  });

  it("mints for the browser's choice with no --workspace and several memberships", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const token = "up_beta_abcdefghijklmnopqrstuvwxyz";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValueOnce(
        response({
          access_token: "sess-tok",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "workspace:beta",
        }),
      )
      .mockResolvedValueOnce(
        response(
          { token, workspace: "beta", scopes: ["files:read"], label: "host", expiresAt: null },
          201,
        ),
      );
    captureOutput();

    // No --workspace: this used to hard-error for multi-workspace accounts.
    expect(await runLogin(["--path", path, "--no-check"], { json: true }, false, silentIo)).toBe(0);
    // The browser answered, so no GET /v1/tokens listing was needed.
    expect(
      fetchMock.mock.calls.some(
        (c) => String(c[0]).endsWith("/v1/tokens") && (c[1] as RequestInit)?.method !== "POST",
      ),
    ).toBe(false);
  });

  it("keeps the CLI provisioning path when the echoed scope still carries create", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    const token = "up_fresh_abcdefghijklmnopqrstuvwxyz";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(deviceCode())
      .mockResolvedValueOnce(
        response({
          access_token: "sess-tok",
          token_type: "Bearer",
          expires_in: 3600,
          // Unchanged by the page: it deferred to the CLI (--create).
          scope: "workspace:fresh create",
        }),
      )
      .mockResolvedValueOnce(response({ workspaces: [] })) // GET /v1/tokens
      .mockResolvedValueOnce(
        response(
          {
            workspace: {
              name: "fresh",
              publicBaseUrl: "https://storage.uploads.sh/fresh",
              selfServe: true,
            },
          },
          201,
        ),
      ) // POST /v1/workspaces
      .mockResolvedValueOnce(
        response(
          { token, workspace: "fresh", scopes: ["files:read"], label: "host", expiresAt: null },
          201,
        ),
      );
    captureOutput();

    expect(
      await runLogin(
        ["--path", path, "--workspace", "fresh", "--create", "--no-check"],
        { json: true },
        false,
        silentIo,
      ),
    ).toBe(0);
    expect(loadConfigFile(path).UPLOADS_WORKSPACE).toBe("fresh");
  });
});

describe("admin enrollment", () => {
  it("uses ADMIN_TOKEN and sends explicit lifetime and scopes", async () => {
    process.env.ADMIN_TOKEN = "admin-secret";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      response(
        {
          pageId: "upi_abcdefghijklmnop",
          code: "upe_abcdefghijklmnopqrstuvwxyz012345",
          expiresAt: "2030-01-01T00:00:00Z",
          tokenExpiresAt: "2030-02-01T00:00:00Z",
        },
        201,
      ),
    );
    captureOutput();
    expect(
      await runAdmin(
        [
          "invite",
          "create",
          "--workspace",
          "default",
          "--expires-in",
          "600",
          "--token-expires-in",
          "86400",
          "--scopes",
          "files:read,files:write",
        ],
        { json: true },
      ),
    ).toBe(0);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer admin-secret");
    expect(JSON.parse(String(init.body))).toEqual({
      workspace: "default",
      enrollmentSeconds: 600,
      tokenExpiresInSeconds: 86400,
      scopes: ["files:read", "files:write"],
    });
    expect(process.env.UPLOADS_TOKEN).toBeUndefined();
  });

  it("omits optional policy fields when flags are absent", async () => {
    process.env.ADMIN_TOKEN = "admin-secret";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      response(
        {
          pageId: "upi_abcdefghijklmnop",
          code: "upe_abcdefghijklmnopqrstuvwxyz012345",
          expiresAt: "2030-01-01T00:00:00Z",
          tokenExpiresAt: "2030-02-01T00:00:00Z",
        },
        201,
      ),
    );
    captureOutput();
    await runAdmin(["enrollment", "create"], { json: true });
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      workspace: "default",
    });
  });

  const enrollmentResponse = () =>
    response(
      {
        pageId: "upi_abcdefghijklmnop",
        code: "upe_abcdefghijklmnopqrstuvwxyz012345",
        expiresAt: "2030-01-01T00:00:00Z",
        tokenExpiresAt: "2030-02-01T00:00:00Z",
      },
      201,
    );

  it("prints a self-contained magic link by default", async () => {
    process.env.ADMIN_TOKEN = "admin-secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(enrollmentResponse());
    const output = captureOutput();
    expect(await runAdmin(["invite", "create"], {})).toBe(0);
    expect(output.out()).toContain(
      "https://uploads.sh/invite?id=upi_abcdefghijklmnop#code=upe_abcdefghijklmnopqrstuvwxyz012345",
    );
    expect(output.out()).not.toContain("share separately");
  });

  it("prints a non-secret page URL and separate code with --separate-code", async () => {
    process.env.ADMIN_TOKEN = "admin-secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(enrollmentResponse());
    const output = captureOutput();
    expect(await runAdmin(["invite", "create", "--separate-code"], {})).toBe(0);
    expect(output.out()).toContain(
      "Invite page: https://uploads.sh/invite?id=upi_abcdefghijklmnop",
    );
    expect(output.out()).toContain(
      "One-time code (share separately): upe_abcdefghijklmnopqrstuvwxyz012345",
    );
    expect(output.out()).not.toContain("#code=");
  });

  it("emails the invite and confirms delivery without printing the code", async () => {
    process.env.ADMIN_TOKEN = "admin-secret";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      response(
        {
          pageId: "upi_abcdefghijklmnop",
          code: "upe_abcdefghijklmnopqrstuvwxyz012345",
          expiresAt: "2030-01-01T00:00:00Z",
          tokenExpiresAt: "2030-02-01T00:00:00Z",
          emailed: true,
        },
        201,
      ),
    );
    const output = captureOutput();
    expect(await runAdmin(["invite", "create", "--email", "adopter@example.com"], {})).toBe(0);
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toMatchObject({
      email: "adopter@example.com",
    });
    expect(output.out()).toContain("Invite emailed to adopter@example.com");
    expect(output.out()).not.toContain("#code=");
    expect(output.out()).not.toContain("upe_abcdefghijklmnopqrstuvwxyz012345");
  });

  it("warns and prints the link as a fallback when email delivery fails", async () => {
    process.env.ADMIN_TOKEN = "admin-secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      response(
        {
          pageId: "upi_abcdefghijklmnop",
          code: "upe_abcdefghijklmnopqrstuvwxyz012345",
          expiresAt: "2030-01-01T00:00:00Z",
          tokenExpiresAt: "2030-02-01T00:00:00Z",
          emailed: false,
        },
        201,
      ),
    );
    const output = captureOutput();
    expect(await runAdmin(["invite", "create", "--email", "adopter@example.com"], {})).toBe(0);
    expect(output.err()).toContain("email delivery failed");
    expect(output.out()).toContain("#code=upe_abcdefghijklmnopqrstuvwxyz012345");
  });

  it("carries the one-time code in the magic link fragment", () => {
    expect(
      inviteMagicLink(
        "https://uploads.sh/invite?id=upi_abcdefghijklmnop",
        "upe_abcdefghijklmnopqrstuvwxyz012345",
      ),
    ).toBe(
      "https://uploads.sh/invite?id=upi_abcdefghijklmnop#code=upe_abcdefghijklmnopqrstuvwxyz012345",
    );
  });

  it("derives or overrides the invite page origin", () => {
    expect(invitePageUrl("https://api.uploads.sh", "upi_abcdefghijklmnop")).toBe(
      "https://uploads.sh/invite?id=upi_abcdefghijklmnop",
    );
    expect(invitePageUrl("https://api.staging.example.com/v1", "upi_abcdefghijklmnop")).toBe(
      "https://staging.example.com/invite?id=upi_abcdefghijklmnop",
    );
    expect(
      invitePageUrl("http://localhost:8787", "upi_abcdefghijklmnop", "http://localhost:4321/setup"),
    ).toBe("http://localhost:4321/invite?id=upi_abcdefghijklmnop");
  });

  it("validates scopes locally", () => {
    expect(parseScopes("files:read, files:delete,files:read")).toEqual([
      "files:read",
      "files:delete",
    ]);
    expect(() => parseScopes("")).toThrow("at least one scope");
    expect(() => parseScopes("files:admin")).toThrow("invalid scope");
  });
});

describe("credential config writes", () => {
  it("writes all credentials and preserves unrelated keys", () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    writeConfigKeys(path, { UPLOADS_DEFAULT_WIDTH: "700" });
    const result = writeConfigKeys(
      path,
      {
        UPLOADS_API_URL: "https://api.uploads.sh",
        UPLOADS_WORKSPACE: "buildinternet",
        UPLOADS_TOKEN: "up_buildinternet_abcdefghijklmnopqrstuvwxyz",
      },
      { force: true },
    );
    expect(result.updated).toEqual(["UPLOADS_API_URL", "UPLOADS_WORKSPACE", "UPLOADS_TOKEN"]);
    expect(loadConfigFile(path)).toMatchObject({
      UPLOADS_DEFAULT_WIDTH: "700",
      UPLOADS_WORKSPACE: "buildinternet",
      UPLOADS_TOKEN: "up_buildinternet_abcdefghijklmnopqrstuvwxyz",
    });
  });

  it("rejects newline injection without modifying the file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    writeConfigKeys(path, { UPLOADS_WORKSPACE: "default" });
    const before = readFileSync(path, "utf8");
    expect(() =>
      writeConfigKeys(path, { UPLOADS_TOKEN: "valid\nINJECTED=yes" }, { force: true }),
    ).toThrow("invalid newline");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

describe("runLogin device flow — mint failure backstop", () => {
  const silentIo: DeviceLoginIo = {
    sleep: async () => {},
    now: () => Date.now(),
    openUrl: () => {},
    write: () => {},
    isTTY: false,
    promptWorkspaceName: async () => "",
  };

  it("names the accessible workspaces when the mint is forbidden", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({
          device_code: "dev-123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://uploads.sh/device",
          expires_in: 900,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        response({ access_token: "sess-tok", token_type: "Bearer", expires_in: 3600, scope: "" }),
      )
      .mockResolvedValueOnce(
        response({ error: "no access to this workspace", code: "workspace_forbidden" }, 403),
      ) // POST /v1/tokens
      .mockResolvedValueOnce(
        response({
          workspaces: [
            { workspace: "acme", role: "member" },
            { workspace: "beta", role: "owner" },
          ],
        }),
      ); // GET /v1/tokens, fetched only to build the error
    captureOutput();

    await expect(
      runLogin(
        ["--path", path, "--workspace", "default", "--no-check"],
        { json: true },
        false,
        silentIo,
      ),
    ).rejects.toThrow(/no access to workspace "default".*acme, beta/s);
  });

  it("still fails clearly when the account has no workspaces at all", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "uploads-login-")), "config");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({
          device_code: "dev-123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://uploads.sh/device",
          expires_in: 900,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        response({ access_token: "sess-tok", token_type: "Bearer", expires_in: 3600, scope: "" }),
      )
      .mockResolvedValueOnce(
        response({ error: "no access to this workspace", code: "workspace_forbidden" }, 403),
      )
      .mockResolvedValueOnce(response({ workspaces: [] }));
    captureOutput();

    await expect(
      runLogin(
        ["--path", path, "--workspace", "default", "--no-check"],
        { json: true },
        false,
        silentIo,
      ),
    ).rejects.toThrow(/no access to workspace "default".*--create/s);
  });
});
