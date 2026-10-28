/**
 * Unsigned-in visits to /account/* and /admin/* go to /login with the
 * original path as callbackURL. Layouts cannot return Astro.redirect
 * (HTML streaming already started); this runs before the page.
 *
 * Cookie-present but expired sessions are handled by the client gate so
 * signed-in loads do not pay an extra getSession here (the layout already
 * resolves the session for first paint).
 */
import { env } from "cloudflare:workers";
import { defineMiddleware } from "astro:middleware";
import { isLocalDemoStack } from "./lib/auth-client";
import { lookupServerSession } from "./lib/auth-proxy";
import { signedInShellLoginRedirect } from "./lib/signed-in-page";

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname, search, origin } = context.url;
  const target = signedInShellLoginRedirect({
    pathname,
    search,
    // #731 phase C: same-origin mode means the browser never learns the
    // auth worker's own origin (authOrigin is always "") — gate on the
    // request's own origin instead (see isLocalDemoStack's doc comment).
    allowLocalDemo: isLocalDemoStack(origin),
    hasCookie: Boolean(context.request.headers.get("cookie")?.trim()),
    sessionKind: null,
  });
  if (target) {
    return new Response(null, {
      status: 302,
      headers: { Location: target, "Cache-Control": "no-store" },
    });
  }
  // AccountLayout needs the session, but it renders after the page's own
  // frontmatter has awaited its data. Starting the lookup here runs the two
  // in parallel; the layout awaits this promise instead of starting its own.
  if (
    pathname.startsWith("/account") &&
    context.request.method === "GET" &&
    context.request.headers.get("cookie")?.trim()
  ) {
    context.locals.sessionLookup = lookupServerSession(env, context.request);
  }
  return next();
});
