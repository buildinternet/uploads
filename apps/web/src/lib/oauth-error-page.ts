/**
 * Copy for `/auth/error`, the page every redirect sign-in failure lands on.
 * Better Auth's `onAPIError.errorURL` points here, and GitHub sign-in,
 * GitHub linking, and magic-link verify set `errorCallbackURL` to the same
 * path. The query `error` code is attacker-controlled on this public URL, so
 * the page never echoes `error_description` — only a code we recognize, or a
 * generic sentence plus the raw code when that code is safe to show.
 */
import { BANNED_ACCOUNT_MESSAGE, isBannedAuthError } from "./auth-client";

export const OAUTH_ERROR_PATH = "/auth/error";

export type OAuthErrorCopy = {
  title: string;
  message: string;
  /** Alphanumeric code safe to show as a support reference. */
  reference: string | null;
};

const GENERIC = {
  title: "Sign-in didn’t complete",
  message: "Something went wrong while signing in. Try again from the sign-in page.",
};

/** Unverified GitHub email (or any other implicit-link refusal). */
const EMAIL_NOT_LINKED = {
  title: "Email isn’t verified",
  message:
    "That GitHub email isn’t verified, so it can’t be linked to an existing account. Use a verified address, or sign in with a magic link.",
};

/**
 * OAuth-provider `/oauth2/authorize` failures that arrive here because
 * `redirect_uri` is not verified yet (`getErrorURL` → `onAPIError.errorURL`).
 * The reference code still shows which check failed.
 */
const INVALID_APP = {
  title: "Invalid app sign-in request",
  message:
    "The app that started this sign-in sent a request uploads.sh couldn’t accept. Check the app’s client and redirect URL, then try again from that app.",
};

const KNOWN: Record<string, { title: string; message: string }> = {
  access_denied: {
    title: "Sign-in cancelled",
    message: "The sign-in was cancelled before it finished. You can try again.",
  },
  state_not_found: {
    title: "Sign-in expired",
    message: "That sign-in attempt expired or was already used. Start again.",
  },
  invalid_callback_request: {
    title: "Sign-in didn’t complete",
    message: "The sign-in response was incomplete. Start again from the sign-in page.",
  },
  invalid_code: {
    title: "Sign-in expired",
    message: "That sign-in code is no longer valid. Start again from the sign-in page.",
  },
  no_code: {
    title: "Sign-in didn’t complete",
    message: "The sign-in response did not include a code. Start again.",
  },
  // generic-oauth only. Built-in GitHub (oauth2/link-account) returns
  // "account not linked", which the callback turns into account_not_linked.
  email_not_verified: EMAIL_NOT_LINKED,
  account_not_linked: EMAIL_NOT_LINKED,
  email_not_found: {
    title: "No email on that account",
    message: "GitHub did not return an email address. Sign in with a magic link instead.",
  },
  email_does_not_match: {
    title: "Email doesn’t match",
    message: "That GitHub account uses a different email than this uploads.sh user.",
  },
  unable_to_link_account: {
    title: "Couldn’t connect GitHub",
    message: "GitHub couldn’t be linked to this account. Try again from your profile.",
  },
  account_already_linked_to_different_user: {
    title: "GitHub account already linked",
    message: "That GitHub account is already linked to a different uploads.sh user.",
  },
  invalid_client: INVALID_APP,
  invalid_redirect: INVALID_APP,
  invalid_request: INVALID_APP,
  unsupported_response_type: INVALID_APP,
  unsupported_prompt_select_account: INVALID_APP,
  client_disabled: INVALID_APP,
  unauthorized_client: INVALID_APP,
  oauth_provider_not_found: GENERIC,
  unable_to_get_user_info: GENERIC,
  issuer_mismatch: GENERIC,
  issuer_missing: GENERIC,
  nonce_binding_missing: GENERIC,
  no_callback_url: GENERIC,
  internal_server_error: GENERIC,
  state_mismatch: {
    title: "Sign-in expired",
    message: "That sign-in attempt expired or was already used. Start again.",
  },
  // Magic-link verify, when the emailed link is missing, used, or expired.
  INVALID_TOKEN: {
    title: "Sign-in link expired",
    message: "That sign-in link is no longer valid. Request a new one from the sign-in page.",
  },
  failed_to_create_session: {
    title: "Sign-in didn’t complete",
    message: "A session couldn’t be started. Try again from the sign-in page.",
  },
  failed_to_create_user: GENERIC,
  user_creation_failed: GENERIC,
  user_not_found: GENERIC,
  new_user_signup_disabled: {
    title: "Email sign-up isn’t available",
    message: "New accounts can’t be created with an email link. Sign in with GitHub instead.",
  },
  signup_disabled: {
    title: "Sign-up isn’t available",
    message: "New accounts can’t be created this way. Sign in with GitHub or an email link.",
  },
  EMAIL_NOT_VERIFIED: {
    title: "Email isn’t verified",
    message: "Verify this email first: sign in once with an email link.",
  },
  temporarily_unavailable: {
    title: "Sign-in is temporarily unavailable",
    message: "uploads.sh couldn’t finish signing you in. Try again in a moment.",
  },
  server_error: GENERIC,
  invalid_scope: INVALID_APP,
  login_required: {
    title: "Sign-in required",
    message: "Sign in to continue, then return to the app that sent you here.",
  },
};

const SAFE_CODE = /^[A-Za-z0-9_-]{1,64}$/;

/** Log line for a hit on `/auth/error`. The code is allowlisted; descriptions are not logged. */
export function authErrorPageLogLine(rawCode: string | null | undefined): string {
  const code = rawCode && SAFE_CODE.test(rawCode) ? rawCode : "rejected";
  return `auth_error_page code=${code}`;
}

/**
 * Map a Better Auth / OAuth `error` query value to page copy.
 * `rawDescription` is read only to recognize a ban phrase. It is never copied
 * into the message or the reference.
 */
export function oauthErrorCopy(
  rawCode: string | null | undefined,
  rawDescription?: string | null,
): OAuthErrorCopy {
  const reference = rawCode && SAFE_CODE.test(rawCode) ? rawCode : null;
  const description =
    typeof rawDescription === "string" &&
    rawDescription.length > 0 &&
    rawDescription.length <= 300 &&
    !/[\r\n]/.test(rawDescription)
      ? rawDescription
      : null;
  if (
    isBannedAuthError({
      error: reference,
      message: description ?? reference,
    })
  ) {
    return {
      title: "Account deactivated",
      message: BANNED_ACCOUNT_MESSAGE,
      reference,
    };
  }
  const known = reference ? KNOWN[reference] : undefined;
  return {
    title: known?.title ?? GENERIC.title,
    message: known?.message ?? GENERIC.message,
    reference,
  };
}
