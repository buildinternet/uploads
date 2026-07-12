import { describe, expect, it } from "vitest";
import { withMarkdownNegotiation } from "./markdown-negotiation";

const SAMPLE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>uploads.sh — test page</title>
    <meta name="description" content="Host media for GitHub PRs." />
    <meta property="og:image" content="https://uploads.sh/og.png" />
  </head>
  <body>
    <nav><a href="/">uploads.sh</a></nav>
    <main>
      <h1>Hello agents</h1>
      <p>One command hosts a <strong>file</strong> at a stable URL.</p>
      <ul>
        <li>CLI</li>
        <li>MCP</li>
      </ul>
    </main>
    <footer>© uploads.sh</footer>
  </body>
</html>`;

function htmlHandler(): Response {
  return new Response(SAMPLE_HTML, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(new TextEncoder().encode(SAMPLE_HTML).byteLength),
      "cache-control": "public, max-age=60",
    },
  });
}

describe("withMarkdownNegotiation", () => {
  it("returns HTML by default when Accept omits text/markdown", async () => {
    const res = await withMarkdownNegotiation(
      new Request("https://uploads.sh/", {
        headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      }),
      htmlHandler,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-markdown-tokens")).toBeNull();
    const body = await res.text();
    expect(body).toContain("<h1>Hello agents</h1>");
    expect(res.headers.get("vary")?.toLowerCase()).toContain("accept");
  });

  it("returns markdown when Accept includes text/markdown", async () => {
    const res = await withMarkdownNegotiation(
      new Request("https://uploads.sh/docs", {
        headers: { Accept: "text/markdown" },
      }),
      htmlHandler,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/markdown/);
    const tokens = res.headers.get("x-markdown-tokens");
    expect(tokens).toBeTruthy();
    expect(Number(tokens)).toBeGreaterThan(0);
    expect(res.headers.get("vary")?.toLowerCase()).toContain("accept");
    expect(res.headers.get("content-signal")).toMatch(/ai-train=no/);
    expect(res.headers.get("content-signal")).toMatch(/search=yes/);
    expect(res.headers.get("content-signal")).toMatch(/ai-input=yes/);
    // Stale HTML length must not leak onto the markdown body.
    expect(res.headers.get("content-length")).toBeNull();

    const body = await res.text();
    expect(body).toMatch(/^---\n/);
    expect(body).toContain("title:");
    expect(body).toContain("Hello agents");
    expect(body).toContain("stable URL");
    // extract:true should drop chrome (nav/footer) from the agent payload.
    expect(body).not.toMatch(/© uploads\.sh/);
    expect(body).not.toContain("<h1>");
  });

  it("does not convert non-HTML responses", async () => {
    const json = `${JSON.stringify({ ok: true })}\n`;
    const res = await withMarkdownNegotiation(
      new Request("https://uploads.sh/.well-known/x", {
        headers: { Accept: "text/markdown" },
      }),
      () =>
        new Response(json, {
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
    );
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-markdown-tokens")).toBeNull();
    expect(await res.text()).toBe(json);
  });

  it("leaves existing text/markdown bodies alone", async () => {
    const md = "# Auth\n\nBearer tokens only.\n";
    const res = await withMarkdownNegotiation(
      new Request("https://uploads.sh/auth.md", {
        headers: { Accept: "text/markdown" },
      }),
      () =>
        new Response(md, {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        }),
    );
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("x-markdown-tokens")).toBeNull();
    expect(await res.text()).toBe(md);
  });
});
