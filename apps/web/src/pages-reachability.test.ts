/**
 * Regression coverage for the repo-wide `run_worker_first` static-404 gotcha
 * (apps/web/wrangler.jsonc, plan D6 ⚠) as it applies to the Phase 2 pages
 * (`/login`, `/admin`) and the Phase 3 `/accept-invitation/[id]` page.
 *
 * Scope note: all three pages set `export const prerender = false` (see
 * login.astro / admin.astro / accept-invitation/[id].astro) — they're SSR
 * routes, always served by
 * `src/entry.ts`'s handler, never prerendered HTML served straight off the
 * `ASSETS` binding. The static-404 failure mode this gotcha describes is
 * specifically about *prerendered* pages bypassing the worker when
 * `run_worker_first` is misconfigured or a route is mishandled before
 * reaching Astro's own routing — so the sharpest test available without a
 * full `astro build` + miniflare ASSETS integration harness (out of scope
 * for a unit test file) is: confirm the shared entry wrapper
 * (`withMarkdownNegotiation`, exercised end-to-end for other routes in
 * markdown-negotiation.test.ts) applies uniformly to these paths under a
 * `Sec-Fetch-Mode: navigate` browser-navigation request — i.e. there is no
 * path-based special case that would make `/login` or `/admin` fall through
 * to a static 404 instead of reaching the page handler.
 */
import { describe, expect, it } from "vitest";
import { withMarkdownNegotiation } from "./markdown-negotiation";

function ssrPageResponse(title: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1></main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

describe.each([
  { path: "/login", title: "Sign in · uploads.sh" },
  { path: "/admin", title: "Admin · uploads.sh" },
  { path: "/admin/users", title: "Users · Admin · uploads.sh" },
  { path: "/admin/email", title: "Email · Admin · uploads.sh" },
  { path: "/accept-invitation/upi_abc123", title: "Accept invitation · uploads.sh" },
  { path: "/account", title: "Account · uploads.sh" },
  { path: "/account/workspaces", title: "Workspaces · uploads.sh" },
  { path: "/account/workspaces/new", title: "New workspace · uploads.sh" },
  { path: "/account/workspaces/buildinternet", title: "buildinternet · uploads.sh" },
  {
    path: "/account/workspaces/buildinternet/galleries",
    title: "Galleries · buildinternet · uploads.sh",
  },
  {
    path: "/account/workspaces/buildinternet/people",
    title: "People · buildinternet · uploads.sh",
  },
  {
    path: "/account/workspaces/buildinternet/settings",
    title: "Settings · buildinternet · uploads.sh",
  },
  { path: "/account/profile", title: "Account · uploads.sh" },
  { path: "/account/developers", title: "Developers · uploads.sh" },
  { path: "/console", title: "uploads.sh console" },
  { path: "/f/acme/screenshots/shot.png", title: "shot.png · uploads.sh" },
])("route reachability: $path", ({ path, title }) => {
  it("reaches the page handler (not a static 404) on a browser navigation request", async () => {
    let handlerCalled = false;
    const res = await withMarkdownNegotiation(
      new Request(`https://uploads.sh${path}`, {
        headers: {
          Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          "Sec-Fetch-Mode": "navigate",
        },
      }),
      () => {
        handlerCalled = true;
        return ssrPageResponse(title);
      },
    );
    expect(handlerCalled).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain(title);
  });
});
