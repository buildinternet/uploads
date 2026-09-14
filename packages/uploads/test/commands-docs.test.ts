import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../src/cli-args.js";
import { runDocs } from "../src/commands/docs.js";
import { FALLBACK_DOCS_CATALOG } from "../src/docs.js";

function captureStreams() {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return {
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("uploads docs", () => {
  it("lists the catalog with no arguments", async () => {
    const { stdout } = captureStreams();
    const code = await runDocs([], { catalog: FALLBACK_DOCS_CATALOG });
    expect(code).toBe(0);
    expect(stdout()).toContain("Docs");
    expect(stdout()).toContain("Attach & share");
    expect(stdout()).toContain("See all docs: https://uploads.sh/docs");
  });

  it("searches a multi-word query", async () => {
    const { stdout } = captureStreams();
    const code = await runDocs(["stage", "before", "PR"], { catalog: FALLBACK_DOCS_CATALOG });
    expect(code).toBe(0);
    expect(stdout()).toContain("Attach & share");
    expect(stdout()).toContain("https://uploads.sh/docs/attach-pull-request-images");
  });

  it("emits JSON when --json is set", async () => {
    const { stdout } = captureStreams();
    const code = await runDocs(["--json"], { catalog: FALLBACK_DOCS_CATALOG });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout()) as { url: string; results: { page: string }[] };
    expect(parsed.url).toBe("https://uploads.sh/docs");
    expect(parsed.results[0]?.page).toBe("docs");
  });

  it("prints help", async () => {
    const { stderr } = captureStreams();
    const code = await runDocs([], { catalog: FALLBACK_DOCS_CATALOG }, true);
    expect(code).toBe(0);
    expect(stderr()).toMatch(/uploads docs/);
    expect(stderr()).toMatch(/Examples:/);
    expect(stderr()).toMatch(/uploads docs --page agents/);
  });

  it("rejects a search query combined with --page", async () => {
    await expect(
      runDocs(["attach", "--page", "agents"], { catalog: FALLBACK_DOCS_CATALOG }),
    ).rejects.toBeInstanceOf(UsageError);
  });

  it("rejects a limit above the cap", async () => {
    await expect(
      runDocs(["--limit", "999"], { catalog: FALLBACK_DOCS_CATALOG }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/50 or less/),
    });
  });

  it("rejects an unknown --page", async () => {
    await expect(
      runDocs(["--page", "not-a-page"], { catalog: FALLBACK_DOCS_CATALOG }),
    ).rejects.toBeInstanceOf(UsageError);
  });
});
