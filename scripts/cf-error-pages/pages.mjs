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
 * The case that matters here: the R2 custom domains answer a link to a file
 * that no longer exists with a 27 KB generic Cloudflare "Not Found" page —
 * complete with a cloudflare.com favicon. Those are exactly the URLs the CLI
 * hands out and that end up embedded in GitHub comments, so a deleted file
 * makes uploads.sh look broken rather than empty.
 *
 * All three public storage hosts are listed. `store.uploads.sh` is the easy
 * one to forget: docs/ops.md documents it as a durable public URL alongside
 * `storage.uploads.sh`, and objects resolve on it identically. Keep this set
 * in step with the "Dual public hosts" table in docs/ops.md.
 *
 * Scoped to those hosts on purpose:
 *   - uploads.sh already serves its own branded 404 from apps/web
 *     (src/pages/404.astro), and a rule here would override it;
 *   - api./auth./agents.uploads.sh answer with JSON error envelopes that
 *     clients parse (packages/errors), and must not be handed HTML.
 */
/**
 * The public storage hosts, in one place because more than one rule needs the
 * same set and duplicating it is how `store.uploads.sh` got missed the first
 * time. Keep in step with the "Dual public hosts" table in docs/ops.md.
 */
const STORAGE_HOSTS = ["storage.uploads.sh", "store.uploads.sh", "embed.uploads.sh"];

/** Ruleset-engine host match over `STORAGE_HOSTS`, for a given response code. */
const onStorageHosts = (code) =>
  `(http.host in {${STORAGE_HOSTS.map((h) => `"${h}"`).join(" ")}} and http.response.code eq ${code})`;

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
    expression: onStorageHosts(404),
    statusCode: 404,
    description: "Branded 404 for missing files on the R2 custom domains",
  },
  {
    /*
     * R2 rejects a malformed key (over-long, bad encoding) with a 400 before
     * any lookup happens, which surfaced as a ~17 KB generic Cloudflare "Bad
     * Request" page on a uploads.sh host (issue #658). Distinct copy from the
     * 404 on purpose: nothing was deleted here, the URL itself is unusable, so
     * "that file isn't here" would send people looking for the wrong problem.
     *
     * Deliberately not covered: 401 (needs a non-GET method, so a browser
     * following an embedded image URL never sees it) and 416 (empty body —
     * there is nothing to replace).
     */
    id: "bad_request",
    label: "400",
    title: "That link isn’t valid",
    message:
      "This URL isn’t a well-formed uploads.sh file link, so there’s no file to look up. It was most likely truncated or mangled on its way here.",
    hint: "Check it against wherever you copied it from — the original may still work.",
    token: null,
    expression: onStorageHosts(400),
    statusCode: 400,
    description: "Branded 400 for malformed keys on the R2 custom domains",
  },
];
