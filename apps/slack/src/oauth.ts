/**
 * "Add to Slack": the OAuth v2 install flow for other workspaces.
 *
 *   GET /slack/install          → 302 to slack.com/oauth/v2/authorize
 *   GET /slack/oauth/callback   ← Slack redirects back with ?code&state
 *
 * CSRF protection follows Slack's guidance: the `state` parameter is a
 * random nonce plus an expiry, signed with SLACK_TOKENS_KEY, and the same
 * nonce is set in a host-only cookie. The callback requires both, so a
 * code minted in someone else's browser can't be replayed into ours.
 *
 * Org-wide (Enterprise Grid) installs are refused for now: they have no
 * single team_id to key the token on.
 * https://docs.slack.dev/authentication/installing-with-oauth
 */
import type { Context } from "hono";
import type { SlackEnv } from "./config";
import { hmac, randomToken, safeEqual, TokensKeyUnconfiguredError } from "./crypto";
import { saveInstall } from "./installs";

/** Bot scopes requested at install. Keep in sync with manifest.json. */
export const BOT_SCOPES = ["links:read", "links:write", "users:read"];
const STATE_COOKIE = "__Host-uploads_slack_oauth";
const STATE_TTL_SECONDS = 10 * 60;
const STATE_LABEL = "slack-oauth-state";

type AppContext = Context<{ Bindings: SlackEnv }>;

function slackOrigin(env: SlackEnv): string {
  return (env.SLACK_ORIGIN || "https://agents.uploads.sh").replace(/\/+$/, "");
}

export function redirectUri(env: SlackEnv): string {
  return `${slackOrigin(env)}/slack/oauth/callback`;
}

async function signState(env: SlackEnv, nonce: string, expires: number): Promise<string> {
  const body = `${nonce}.${expires}`;
  return `${body}.${await hmac(env.SLACK_TOKENS_KEY, STATE_LABEL, body)}`;
}

/** The nonce inside a state value that is well-formed, unexpired, and signed by us; else null. */
export async function verifyState(
  env: SlackEnv,
  state: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const [nonce, expiresRaw, mac, ...rest] = state.split(".");
  if (!nonce || !expiresRaw || !mac || rest.length > 0 || !/^\d{1,12}$/.test(expiresRaw)) {
    return null;
  }
  if (Number(expiresRaw) < nowSeconds) return null;
  const expected = await hmac(env.SLACK_TOKENS_KEY, STATE_LABEL, `${nonce}.${expiresRaw}`);
  return safeEqual(mac, expected) ? nonce : null;
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** A small self-contained result page; no scripts, nothing external. */
export function resultPage(title: string, body: string, action?: { href: string; label: string }) {
  const button = action
    ? `<p><a class="button" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a></p>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · uploads.sh</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #121214; color: #ececf1; font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 28rem; padding: 2rem 1rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { color: #b4b4bd; margin: 0 0 1rem; }
  .button { display: inline-block; padding: .5rem 1rem; border-radius: .5rem;
    background: #c27eff; color: #121214; font-weight: 600; text-decoration: none; }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${button}</main></body></html>`;
}

function page(
  c: AppContext,
  status: 200 | 400 | 502 | 503,
  ...args: Parameters<typeof resultPage>
) {
  return c.html(resultPage(...args), status, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "Referrer-Policy": "no-referrer",
  });
}

function clearStateCookie(): string {
  return `${STATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** GET /slack/install */
export async function handleInstall(c: AppContext): Promise<Response> {
  const { SLACK_CLIENT_ID: clientId } = c.env;
  if (!clientId || !c.env.SLACK_CLIENT_SECRET || !c.env.DB) {
    return page(
      c,
      503,
      "Install isn't available",
      "The uploads.sh Slack app isn't set up to accept installs yet.",
    );
  }
  let state: string;
  const nonce = randomToken();
  try {
    state = await signState(c.env, nonce, Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS);
  } catch (err) {
    if (err instanceof TokensKeyUnconfiguredError) {
      return page(
        c,
        503,
        "Install isn't available",
        "The uploads.sh Slack app isn't set up to accept installs yet.",
      );
    }
    throw err;
  }
  const authorize = new URL("https://slack.com/oauth/v2/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("scope", BOT_SCOPES.join(","));
  authorize.searchParams.set("redirect_uri", redirectUri(c.env));
  authorize.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.href,
      "Cache-Control": "no-store",
      "Set-Cookie": `${STATE_COOKIE}=${nonce}; Path=/; Max-Age=${STATE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

interface OAuthAccess {
  ok: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id: string; name?: string } | null;
  enterprise?: { id: string } | null;
  is_enterprise_install?: boolean;
  authed_user?: { id?: string };
}

export interface OAuthOptions {
  /** Overrides the fetch used for slack.com calls (tests). */
  slackFetch?: typeof globalThis.fetch;
}

/** GET /slack/oauth/callback */
export async function handleCallback(c: AppContext, options: OAuthOptions = {}): Promise<Response> {
  const env = c.env;
  const respond = async (status: 200 | 400 | 502 | 503, ...args: Parameters<typeof resultPage>) => {
    const res = page(c, status, ...args);
    res.headers.append("Set-Cookie", clearStateCookie());
    return res;
  };

  if (c.req.query("error") === "access_denied") {
    return respond(200, "Install cancelled", "Nothing was installed. You can close this tab.");
  }
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET || !env.DB) {
    return respond(
      503,
      "Install isn't available",
      "The uploads.sh Slack app isn't set up to accept installs yet.",
    );
  }

  const code = c.req.query("code");
  const state = c.req.query("state") ?? "";
  const cookieNonce = readCookie(c.req.header("Cookie"), STATE_COOKIE);
  let nonce: string | null = null;
  try {
    nonce = await verifyState(env, state);
  } catch (err) {
    if (!(err instanceof TokensKeyUnconfiguredError)) throw err;
  }
  if (!code || !nonce || !cookieNonce || !safeEqual(nonce, cookieNonce)) {
    return respond(
      400,
      "That install link expired",
      "Start again from the Add to Slack button. Install links work once, for ten minutes, in the browser that opened them.",
      { href: "/slack/install", label: "Add to Slack" },
    );
  }

  let access: OAuthAccess;
  try {
    const response = await (options.slackFetch ?? globalThis.fetch)(
      "https://slack.com/api/oauth.v2.access",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.SLACK_CLIENT_ID,
          client_secret: env.SLACK_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri(env),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    access = (await response.json()) as OAuthAccess;
  } catch (err) {
    console.error("slack.oauth: oauth.v2.access failed", String(err));
    return respond(502, "Slack didn't answer", "Try installing again in a minute.", {
      href: "/slack/install",
      label: "Try again",
    });
  }

  if (!access.ok || !access.access_token || access.token_type !== "bot") {
    console.error("slack.oauth: install rejected", { error: access.error });
    return respond(
      400,
      "Install didn't finish",
      `Slack said: ${access.error ?? "unknown error"}.`,
      {
        href: "/slack/install",
        label: "Try again",
      },
    );
  }
  if (access.is_enterprise_install || !access.team?.id) {
    return respond(
      400,
      "Org-wide installs aren't supported yet",
      "Install uploads.sh into a single workspace instead of the whole organization.",
    );
  }

  await saveInstall(env.DB, env.SLACK_TOKENS_KEY, {
    teamId: access.team.id,
    teamName: access.team.name ?? null,
    enterpriseId: access.enterprise?.id ?? null,
    appId: access.app_id ?? env.SLACK_APP_ID ?? "",
    botUserId: access.bot_user_id ?? null,
    botToken: access.access_token,
    scopes: access.scope ?? "",
    installedBySlackUserId: access.authed_user?.id ?? null,
  });
  console.log("slack.oauth: installed", { team: access.team.id });

  const openSlack = new URL("https://slack.com/app_redirect");
  openSlack.searchParams.set("team", access.team.id);
  if (env.SLACK_APP_ID) openSlack.searchParams.set("app", env.SLACK_APP_ID);
  return respond(
    200,
    `uploads.sh is installed${access.team.name ? ` in ${access.team.name}` : ""}`,
    "Public uploads.sh links posted in this workspace now get a preview.",
    { href: openSlack.href, label: "Open Slack" },
  );
}
