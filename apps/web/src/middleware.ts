/**
 * Unsigned-in visits to /account/* and /admin/* go to /login with the
 * original path as callbackURL. Layouts cannot return Astro.redirect
 * (HTML streaming already started); this runs before the page.
 *
 * Cookie-present but expired sessions are handled by the client gate so
 * signed-in loads do not pay an extra getSession here (the layout already
 * resolves the session for first paint).
 */
import { defineMiddleware } from "astro:middleware";
import { isLocalDemoStack } from "./lib/auth-client";
import { resolveSignedInOrigins, signedInShellLoginRedirect } from "./lib/signed-in-page";

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname, search, origin } = context.url;
  const { authOrigin } = resolveSignedInOrigins();
  const target = signedInShellLoginRedirect({
    pathname,
    search,
    allowLocalDemo: isLocalDemoStack(authOrigin, origin),
    hasCookie: Boolean(context.request.headers.get("cookie")?.trim()),
    sessionKind: null,
  });
  if (target) {
    return new Response(null, {
      status: 302,
      headers: { Location: target, "Cache-Control": "no-store" },
    });
  }
  return next();
});
