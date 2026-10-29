import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { outputFormat, runCli } from "../src/cli.js";

describe("outputFormat", () => {
  it("global --json wins over --format", () => {
    expect(outputFormat(["n", "u", "put", "x", "--format", "url", "--json"])).toBe("json");
  });
  it("detects a --format json value", () => {
    expect(outputFormat(["n", "u", "put", "x", "--format", "json"])).toBe("json");
  });
  it("detects --format=url", () => {
    expect(outputFormat(["n", "u", "put", "x", "--format=url"])).toBe("url");
  });
  it("defaults to human", () => {
    expect(outputFormat(["n", "u", "put", "x"])).toBe("human");
  });
});

describe("runCli surfaces failures on stdout for scripted output", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes a structured JSON error to stdout under --json", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // `--token` with no value throws a UsageError through the top-level catch.
    const code = await runCli(["node", "uploads", "--json", "--token"]);

    expect(code).toBe(2);
    const parsed = JSON.parse(out.join("")) as { error: string; code: string };
    expect(parsed.error).toMatch(/missing value for --token/);
    expect(parsed.code).toBe("USAGE");
  });
});

describe("missing token is an onboarding nudge, not an error: framing", () => {
  beforeEach(() => {
    vi.stubEnv("BUILDINTERNET_CONFIG", "/nonexistent/uploads-missing-token-test-config");
    vi.stubEnv("UPLOADS_TOKEN", "");
    vi.stubEnv("UPLOADS_WORKSPACE", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("human put without a token has no 'error:' prefix and leads with login", async () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });

    const code = await runCli(["node", "uploads", "put", "/tmp/does-not-need-to-exist.png"]);
    expect(code).toBe(2);
    const printed = err.join("");
    expect(printed).toMatch(/not signed in yet/i);
    expect(printed).toMatch(/uploads login/);
    expect(printed).not.toMatch(/^error:/m);
    expect(printed).not.toMatch(/\nerror:/);
  });

  it("--format url without a token writes a short non-error nudge to stdout", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await runCli(["node", "uploads", "put", "/tmp/x.png", "--format", "url"]);
    expect(code).toBe(2);
    const printed = out.join("");
    expect(printed).toMatch(/not signed in/i);
    expect(printed).toMatch(/uploads login/);
    expect(printed).not.toMatch(/^error:/m);
  });

  it("--json still exposes MISSING_TOKEN for agents", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await runCli(["node", "uploads", "--json", "put", "/tmp/x.png"]);
    expect(code).toBe(2);
    const parsed = JSON.parse(out.join("")) as { error: string; code: string };
    expect(parsed.code).toBe("MISSING_TOKEN");
    expect(parsed.error).toMatch(/uploads login/);
  });
});

describe("insufficient scope names the scope and how to get it", () => {
  beforeEach(() => {
    vi.stubEnv("BUILDINTERNET_CONFIG", "/nonexistent/uploads-scope-test-config");
    vi.stubEnv("UPLOADS_TOKEN", "up_test_scope");
    vi.stubEnv("UPLOADS_WORKSPACE", "test");
    vi.stubEnv("UPLOADS_API_URL", "https://api.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function forbidden() {
    return new Response(
      JSON.stringify({
        error: {
          type: "insufficient_scope",
          code: "insufficient_scope",
          message: "forbidden",
          details: { required_scope: "files:delete" },
        },
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }

  it("puts required_scope and the remedy hint on --json", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => forbidden()),
    );

    const code = await runCli(["node", "uploads", "--json", "delete", "screenshots/a.png"]);
    expect(code).not.toBe(0);
    const parsed = JSON.parse(out.join("")) as {
      error: string;
      code: string;
      required_scope?: string;
      hint?: string;
    };
    expect(parsed.code).toBe("INSUFFICIENT_SCOPE");
    expect(parsed.required_scope).toBe("files:delete");
    expect(parsed.error).toContain("files:delete");
    expect(parsed.hint).toContain("https://uploads.sh/account/developers");
    expect(parsed.error).toContain(parsed.hint);
  });

  it("prints the remedy once on a human error", async () => {
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => forbidden()),
    );

    await runCli(["node", "uploads", "delete", "screenshots/a.png"]);
    const printed = err.join("");
    expect(printed).toContain("files:delete");
    expect(printed).toContain("https://uploads.sh/account/developers");
    expect(printed.match(/uploads\.sh\/account\/developers/g)).toHaveLength(1);
  });
});

async function runQuotaDelete(status: number, code: string, message: string) {
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code, message } }), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
  const exit = await runCli(["node", "uploads", "delete", "screenshots/a.png"]);
  return { exit, printed: err.join("") };
}

describe("quota hints tell a customer what to do", () => {
  beforeEach(() => {
    vi.stubEnv("BUILDINTERNET_CONFIG", "/nonexistent/uploads-quota-test-config");
    vi.stubEnv("UPLOADS_TOKEN", "up_test_quota");
    vi.stubEnv("UPLOADS_WORKSPACE", "acme");
    vi.stubEnv("UPLOADS_API_URL", "https://api.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prints a customer storage-quota hint and keeps the server remedy", async () => {
    const message =
      "storage quota exceeded (1 + 2 > 3 bytes). Upgrade your plan (https://uploads.sh/account/workspaces/acme/billing) or connect your own bucket (https://uploads.sh/account/workspaces/acme/storage#bucket).";
    const { exit, printed } = await runQuotaDelete(507, "storage_quota_exceeded", message);
    expect(exit).not.toBe(0);
    expect(printed).toContain(message);
    expect(printed).toContain(
      "hint: run `uploads usage`, delete objects, or upgrade your plan or connect your own bucket: https://uploads.sh/docs/limits",
    );
    expect(printed).not.toContain("workspace:limits");
  });

  it("does not offer a bucket for the monthly upload cap", async () => {
    const { printed } = await runQuotaDelete(
      429,
      "upload_budget_exceeded",
      "upload budget exceeded (10/10 this period)",
    );
    expect(printed).toContain(
      "hint: run `uploads usage`, or upgrade your plan: https://uploads.sh/docs/limits",
    );
    expect(printed).not.toContain("connect your own bucket");
    expect(printed).not.toContain("workspace:limits");
  });
});
