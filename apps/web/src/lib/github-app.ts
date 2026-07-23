/**
 * Canonical uploads-sh GitHub App URLs.
 *
 * Two of them, because the links mean different things:
 * - `GITHUB_APP_INSTALL_URL` lands on GitHub's repository picker. Use it
 *   wherever the label is an imperative ("install …").
 * - `GITHUB_APP_URL` is the App's public page, which carries the pitch. Use it
 *   where the link means "learn what this is".
 *
 * The footer deliberately uses neither — it links to `/docs/github-app`, which
 * teaches first and is also the App's configured Setup URL.
 */
export const GITHUB_APP_URL = "https://github.com/apps/uploads-sh";
export const GITHUB_APP_INSTALL_URL = `${GITHUB_APP_URL}/installations/new`;
