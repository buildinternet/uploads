/**
 * The Cloudflare Error Page types this repo customizes, shared by build.mjs
 * (which renders them) and deploy.mjs (which uploads and wires them up).
 *
 * Error Pages only cover errors Cloudflare itself generates. Errors that come
 * back from an origin need a Custom Error Rule instead — see `RULES` below.
 */
export const PAGES = [
  {
    id: "500_errors",
    label: "5xx",
    title: "uploads.sh is unreachable",
    message:
      "Cloudflare couldn’t get a response from the uploads.sh origin. This isn’t a missing URL — the server is down, timing out, or erroring before it can answer.",
    hint: "Nothing you did caused this, and no upload was lost. Try again in a moment.",
    token: "::CLOUDFLARE_ERROR_500S_BOX::",
  },
  {
    id: "1000_errors",
    label: "1xxx",
    title: "This request couldn’t be completed",
    message:
      "A DNS or domain configuration problem stopped this request from reaching uploads.sh, so it never made it to the application.",
    hint: "This is a configuration issue on our side, not a bad link.",
    token: "::CLOUDFLARE_ERROR_1000S_BOX::",
  },
  {
    id: "waf_block",
    label: "403",
    title: "Request blocked",
    message:
      "Our firewall blocked this request before it reached uploads.sh. Automated rules sometimes catch ordinary traffic — a large upload, an unusual client, a shared network.",
    hint: "If you were doing something normal, this is a false positive worth reporting.",
    token: null,
  },
  {
    id: "ip_block",
    label: "403",
    title: "Access blocked",
    message:
      "Requests from your IP address or region are blocked on uploads.sh. This is an access rule on the zone, not a problem with the page you asked for.",
    hint: "If you think this is wrong, open an issue and include the Ray ID below.",
    token: null,
  },
  {
    id: "ratelimit_block",
    label: "429",
    title: "Too many requests",
    message:
      "You’ve gone past the rate limit for uploads.sh. The limit is per-client and resets on its own — nothing is permanently blocked.",
    hint: "Wait a moment and retry. If a script is looping, slow it down before retrying.",
    token: null,
  },
  {
    id: "basic_challenge",
    label: "checking",
    title: "Verifying your browser",
    message:
      "This takes a few seconds and happens once. You’ll continue automatically when it finishes.",
    hint: null,
    token: "::CAPTCHA_BOX::",
  },
  {
    // Legacy WAF captcha. Cloudflare accepts a write here on the Pro plan but
    // never persists it (deploy.mjs reads the page back and reports SKIPPED).
    // Kept in the list so it picks itself up if the plan ever changes — the
    // challenge visitors actually see today is `managed_challenge`.
    id: "waf_challenge",
    label: "checking",
    title: "Verifying your browser",
    message:
      "A firewall rule asked for a quick check before this request continues. It takes a few seconds and you’ll go through automatically.",
    hint: null,
    token: "::CAPTCHA_BOX::",
  },
  {
    id: "country_challenge",
    label: "checking",
    title: "Verifying your browser",
    message:
      "Requests from your region get a quick check first. It takes a few seconds, then you’ll continue automatically.",
    hint: null,
    token: "::CAPTCHA_BOX::",
  },
  {
    id: "managed_challenge",
    label: "checking",
    title: "Verifying your browser",
    message:
      "This takes a few seconds and happens once. You’ll continue automatically when it finishes.",
    hint: null,
    token: "::CAPTCHA_BOX::",
  },
  {
    id: "under_attack",
    label: "checking",
    title: "Checking your connection",
    message:
      "uploads.sh is under elevated protection right now, so every visitor gets a short automatic check before continuing. No action needed.",
    hint: null,
    token: "::IM_UNDER_ATTACK_BOX::",
  },
];

/**
 * Custom Error Rules (the `http_custom_errors` ruleset phase). These catch
 * error responses that come back from an *origin*, which Error Pages above
 * deliberately do not cover.
 *
 * The case that matters here: storage.uploads.sh and embed.uploads.sh are R2
 * custom domains, so a link to a file that no longer exists is answered by R2
 * itself with a 27 KB generic Cloudflare "Not Found" page — complete with a
 * cloudflare.com favicon. Those are exactly the URLs the CLI hands out and
 * that end up embedded in GitHub comments, so a deleted file currently makes
 * uploads.sh look broken rather than empty.
 *
 * Scoped to those two hosts on purpose:
 *   - uploads.sh already serves its own branded 404 from apps/web
 *     (src/pages/404.astro), and a rule here would override it;
 *   - api./auth./agents.uploads.sh answer with JSON error envelopes that
 *     clients parse (packages/errors), and must not be handed HTML.
 */
export const RULES = [
  {
    /** Asset name registered with Cloudflare, and the built file's basename. */
    id: "file_not_found",
    label: "404",
    title: "That file isn’t here",
    message:
      "This link points at a file that isn’t on uploads.sh anymore. It may have been deleted, replaced by a newer upload, or the URL is wrong.",
    hint: "If this link used to work, the file or its workspace was removed.",
    token: null,
    expression:
      '(http.host in {"storage.uploads.sh" "embed.uploads.sh"} and http.response.code eq 404)',
    statusCode: 404,
    description: "Branded 404 for missing files on the R2 custom domains",
  },
];
