/**
 * Shared server helpers for the signed-in shells (/account/*, /admin/*):
 * origins, CSP, console-link visibility, and the data-URL favicon.
 */
import { resolveConsoleMode } from "./console-mode";
import { CF_RUM_CONNECT_SRC, CF_RUM_SCRIPT_SRC, STYLE_SRC_SELF_AND_INLINE } from "./csp";

/** Tiny chevron mark as a data URL — keeps signed-in pages free of asset fetches. */
export const SITE_FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23121214'/%3E%3Cg fill='none' stroke='%23b794ff' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M8 12.5 L16 5 L24 12.5'/%3E%3Cpath d='M8 19.5 L16 12 L24 19.5' opacity='.55'/%3E%3Cpath d='M8 26.5 L16 19 L24 26.5' opacity='.28'/%3E%3C/g%3E%3C/svg%3E";

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
