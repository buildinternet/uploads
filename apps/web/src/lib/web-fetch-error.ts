/**
 * Last-resort Worker error boundary for the web origin. Astro already maps
 * page throws to 500.astro; this covers unexpected throws in the markdown
 * wrapper or the adapter itself so a crash still returns the branded page
 * instead of a Cloudflare 1101.
 */

export async function respondWebFetchFailure(
  request: Request,
  assets: { fetch: (input: RequestInfo | URL) => Promise<Response> } | undefined,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const accept = request.headers.get("accept") ?? "";
  if (path !== "/500" && accept.includes("text/html") && assets) {
    try {
      const page = await assets.fetch(new URL("/500", request.url));
      return new Response(page.body, {
        status: 500,
        statusText: "Internal Server Error",
        headers: page.headers,
      });
    } catch {
      // Fall through to the plain-text body.
    }
  }
  return new Response("Internal Server Error", {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
