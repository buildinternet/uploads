import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncSessionCliVersion } from "../src/session-cli-version.js";

describe("syncSessionCliVersion", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    vi.unstubAllEnvs();
  });

  function tmpConfig(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), "uploads-cli-ver-"));
    dirs.push(dir);
    const path = join(dir, "config");
    writeFileSync(path, contents);
    return path;
  }

  it("no-ops without a session token", async () => {
    const path = tmpConfig("UPLOADS_API_URL=https://api.uploads.sh\n");
    const fetchImpl = vi.fn();
    expect(
      await syncSessionCliVersion({
        envFile: path,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        force: true,
      }),
    ).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs update-session and skips when the version is unchanged", async () => {
    const path = tmpConfig(
      ["UPLOADS_API_URL=https://api.example.test", "UPLOADS_SESSION_TOKEN=sess_test", ""].join(
        "\n",
      ),
    );
    const cachePath = join(path, "..", "cache");
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ session: {} }), { status: 200 }),
    );

    expect(
      await syncSessionCliVersion({
        envFile: path,
        version: "1.2.3",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        cachePath,
        force: true,
      }),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://auth.example.test/api/auth/update-session");
    expect(JSON.parse(String(call[1].body))).toEqual({ cliVersion: "1.2.3" });
    expect(readFileSync(cachePath, "utf8").trim()).toBe("1.2.3");

    expect(
      await syncSessionCliVersion({
        envFile: path,
        version: "1.2.3",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        cachePath,
      }),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    expect(
      await syncSessionCliVersion({
        envFile: path,
        version: "1.2.4",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        cachePath,
      }),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("drops UPLOADS_SESSION_TOKEN on 401", async () => {
    const path = tmpConfig(
      "UPLOADS_SESSION_TOKEN=sess_x\nUPLOADS_API_URL=https://api.uploads.sh\nUPLOADS_TOKEN=up_ws_abc\n",
    );
    await syncSessionCliVersion({
      envFile: path,
      version: "9.9.9",
      force: true,
      fetchImpl: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch,
      cachePath: join(path, "..", "cache-401"),
    });
    const { loadConfigFile } = await import("../src/config-file.js");
    const cfg = loadConfigFile(path);
    expect(cfg.UPLOADS_SESSION_TOKEN).toBeUndefined();
    expect(cfg.UPLOADS_TOKEN).toBe("up_ws_abc");
  });
});
