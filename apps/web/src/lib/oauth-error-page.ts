/**
 * Copy for `/auth/error`, the page Better Auth sends OAuth failures to
 * (`onAPIError.errorURL` in apps/auth). The query `error` code is
 * attacker-controlled on this public URL, so the page never echoes
 * `error_description` — only a code we recognize, or a generic sentence.
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
};

const SAFE_CODE = /^[A-Za-z0-9_-]{1,64}$/;

/** Map a Better Auth / OAuth `error` query value to page copy. */
export function oauthErrorCopy(rawCode: string | null | undefined): OAuthErrorCopy {
  const reference = rawCode && SAFE_CODE.test(rawCode) ? rawCode : null;
  if (
    isBannedAuthError({
      error: reference,
      message: reference,
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
