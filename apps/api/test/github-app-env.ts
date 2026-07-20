/**
 * Shared GitHub App env fixture for title-resolution tests. The key material
 * is a dummy: these tests either pre-seed `ghtok:*` in the KV fake (so no JWT
 * is ever minted) or never reach GitHub at all (cache-only route fixtures).
 */
export const GITHUB_APP_CFG_ENV = {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: "unused",
  GITHUB_APP_HOME_INSTALLATION_ID: "777",
  WEB_ORIGIN: "https://uploads.sh",
};
