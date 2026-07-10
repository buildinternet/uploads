import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEnrollmentCode, runLogin, validateEnrollmentCode } from "../src/commands/login.js";
import { parseScopes, runAdmin } from "../src/commands/admin-enrollment.js";
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

describe("admin enrollment", () => {
  it("uses ADMIN_TOKEN and sends explicit lifetime and scopes", async () => {
    process.env.ADMIN_TOKEN = "admin-secret";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      response(
        {
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
          "enrollment",
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
