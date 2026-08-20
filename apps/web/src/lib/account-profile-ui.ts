/**
 * Shared data loader + markup for /account/profile (issue #699) so SSR and
 * the client paint the same "Sign-in methods" and "Sessions" rows. Mirrors
 * developers-ui.ts's shape: a pure loader returning `T | null` fields (null =
 * no cookie / fetch failed) plus pure, server-safe HTML renderers the client
 * re-invokes to reconcile after its own fetch.
 */
import {
  getAccountInfo,
  getSession,
  listAccounts,
  listSessions,
  type AuthSession,
  type LinkedAccount,
  type ProviderAccountInfo,
  type SessionUser,
} from "./auth-client";
import { githubMarkSvg } from "./brand-icons";
import { deviceLabel, formatSessionTime, isCliUserAgent } from "./session-device";
import { escapeHtml } from "./workspace-ui";

export interface ProfilePageData {
  user: SessionUser | null;
  /** Current session's token (drives "This device" ordering/badge); null when unresolved. */
  currentToken: string | null;
  accounts: LinkedAccount[] | null;
  /** Live GitHub profile when a github account is linked; null otherwise or on failure. */
  githubInfo: ProviderAccountInfo | null;
  sessions: AuthSession[] | null;
}

/**
 * Server-side data for /account/profile. An empty/missing cookie short-
 * circuits to all-null fields (first paint falls back to the placeholder and
 * the client fetch fills in, same contract as `loadDevelopersPageData`). The
 * github-info lookup is sequential — it needs the linked account's id from
 * `listAccounts` — mirroring the client's original `loadAccounts()`.
 */
export async function loadProfilePageData(
  authOrigin: string,
  cookie: string,
): Promise<ProfilePageData> {
  if (!cookie.trim()) {
    return { user: null, currentToken: null, accounts: null, githubInfo: null, sessions: null };
  }

  const [sessionResult, accounts, sessions] = await Promise.all([
    getSession(authOrigin, { cookie }),
    listAccounts(authOrigin, { cookie }),
    listSessions(authOrigin, { cookie }),
  ]);

  const user = sessionResult.kind === "signed_in" ? sessionResult.session.user : null;
  const tokenValue =
    sessionResult.kind === "signed_in" ? sessionResult.session.session?.token : undefined;
  const currentToken = typeof tokenValue === "string" ? tokenValue : null;

  // Live GitHub profile when linked (account-info needs list-accounts id).
  const github = accounts?.find((a) => a.providerId === "github") ?? null;
  const githubInfo = github
    ? await getAccountInfo(authOrigin, {
        providerId: "github",
        accountId: github.accountId,
        cookie,
      })
    : null;

  return { user, currentToken, accounts, githubInfo, sessions };
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Official GitHub mark (same path as releases AccountIcon) — not a Lucide
// brand icon; Lucide dropped brand logos.
const GITHUB_ICON = githubMarkSvg({ size: 14, className: "detail-icon" });

function githubDetail(account: LinkedAccount, info: ProviderAccountInfo | null): string {
  const parts: string[] = [];
  const login = asNonEmptyString(info?.data?.login);
  if (login) parts.push(`@${login}`);
  const email = asNonEmptyString(info?.user?.email) ?? asNonEmptyString(info?.data?.email);
  if (email) parts.push(email);
  parts.push(`id ${account.accountId}`);
  if (account.scopes?.length) parts.push(`scopes ${account.scopes.join(", ")}`);
  return parts.join(" · ");
}

type MethodRow = {
  title: string;
  detail: string;
  ok: boolean;
  icon?: string;
  connectGithub?: boolean;
};

/**
 * Sign-in-methods list rows: linked providers (GitHub gets a live-profile
 * detail line + icon), a magic-link fallback row when nothing is linked, and
 * a "Connect" row appended whenever GitHub isn't linked. Never empty, so
 * unlike the other renderers in this file callers don't need a separate
 * empty-state branch. Server-safe — no window/document access.
 */
export function renderSignInMethodsHtml(
  accounts: LinkedAccount[],
  githubInfo: ProviderAccountInfo | null,
): string {
  const github = accounts.find((a) => a.providerId === "github");

  const rows: MethodRow[] =
    accounts.length > 0
      ? accounts.map((a) => {
          if (a.providerId === "github") {
            return {
              title: "GitHub",
              detail: githubDetail(a, githubInfo),
              ok: true,
              icon: GITHUB_ICON,
            };
          }
          return {
            title: a.providerId,
            detail: a.createdAt ? `Linked ${formatSessionTime(a.createdAt)}` : "Connected",
            ok: true,
          };
        })
      : [{ title: "Email", detail: "Magic link sign-in", ok: true }];

  if (!github) {
    rows.push({
      title: "GitHub",
      detail: "Not connected",
      ok: false,
      icon: GITHUB_ICON,
      connectGithub: true,
    });
  }

  return rows
    .map((row) => {
      const action = row.connectGithub
        ? `<div class="detail-action">
                <button type="button" class="text-btn text-btn--boxed" data-connect-github>Connect</button>
              </div>`
        : "";
      // Unconnected rows carry no badge: the meta line already says
      // "Not connected", and the boxed Connect button is the state cue.
      const badge = row.ok ? `<span class="ul-badge ul-badge--ok">Connected</span>` : "";
      return `<li>
            <div class="detail-main">
              <div class="detail-title">
                ${row.icon ?? ""}
                <span>${escapeHtml(row.title)}</span>
                ${badge}
              </div>
              <div class="detail-meta">${escapeHtml(row.detail)}</div>
            </div>
            ${action}
          </li>`;
    })
    .join("");
}

/**
 * Sessions list rows, current-session-first then most-recently-active.
 * `[]` → `""` — the caller decides the "No active sessions." status text and
 * hides the list, same branching the client used before this shared
 * renderer existed.
 */
export function renderSessionsHtml(sessions: AuthSession[], currentToken: string | null): string {
  if (!sessions.length) return "";
  // Copy-then-sort (not `toSorted`) so this shared renderer stays non-mutating
  // without depending on ES2023 array methods in either runtime (#714 review).
  const ordered = [...sessions].sort((a, b) => {
    if (currentToken && a.token === currentToken) return -1;
    if (currentToken && b.token === currentToken) return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  return ordered
    .map((s) => {
      const current = currentToken != null && s.token === currentToken;
      const badge = current
        ? `<span class="ul-badge ul-badge--accent">This device</span>`
        : isCliUserAgent(s.userAgent)
          ? `<span class="ul-badge">CLI</span>`
          : "";
      const meta = [
        s.ipAddress ? escapeHtml(s.ipAddress) : null,
        `Active ${escapeHtml(formatSessionTime(s.updatedAt))}`,
      ]
        .filter(Boolean)
        .join(" · ");
      const action = current
        ? `<span class="detail-current">Current</span>`
        : `<button type="button" class="text-btn" data-revoke="${escapeHtml(s.token)}">Sign out</button>`;
      return `<li>
            <div class="detail-main">
              <div class="detail-title">
                <span>${escapeHtml(deviceLabel(s.userAgent, { cliVersion: s.cliVersion }))}</span>
                ${badge}
              </div>
              <div class="detail-meta">${meta}</div>
            </div>
            <div class="detail-action">${action}</div>
          </li>`;
    })
    .join("");
}
