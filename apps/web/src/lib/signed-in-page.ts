/**
 * Shared server helpers for the signed-in shells (/account/*, /admin/*):
 * origins, CSP, and console-link visibility. The favicon ships via BaseHead.
 */
import { resolveConsoleMode } from "./console-mode";
import { CF_RUM_CONNECT_SRC, CF_RUM_SCRIPT_SRC, STYLE_SRC_SELF_AND_INLINE } from "./csp";

type OriginEnv = {
  UPLOADS_AUTH_ORIGIN?: string;
  UPLOADS_API_ORIGIN?: string;
};

export function resolveSignedInOrigins(env: OriginEnv): {
  authOrigin: string;
  apiOrigin: string;
} {
  return {
    authOrigin:
      env.UPLOADS_AUTH_ORIGIN ??
      import.meta.env.PUBLIC_UPLOADS_AUTH_ORIGIN ??
      "https://auth.uploads.sh",
    apiOrigin:
      env.UPLOADS_API_ORIGIN ??
      import.meta.env.PUBLIC_UPLOADS_API_ORIGIN ??
      "https://api.uploads.sh",
  };
}

/** Strict CSP used by /account/* and /admin/* (session + API fetches only). */
export function signedInCsp(authOrigin: string, apiOrigin: string): string {
  return [
    "default-src 'none'",
    `connect-src ${authOrigin} ${apiOrigin} ${CF_RUM_CONNECT_SRC}`,
    `script-src 'self' 'unsafe-inline' ${CF_RUM_SCRIPT_SRC}`,
    `style-src ${STYLE_SRC_SELF_AND_INLINE}`,
    "font-src 'self'",
    "img-src data: https:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Visibility knob for /console links — not a security boundary (console auth
 * is bearer-token based). Only `"public"` surfaces links from account/admin.
 */
export async function resolveShowConsoleLinks(
  env: Parameters<typeof resolveConsoleMode>[0],
): Promise<boolean> {
  return (await resolveConsoleMode(env)) === "public";
}
