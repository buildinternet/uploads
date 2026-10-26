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
  listDigestPreferences,
  listSessions,
  type AuthSession,
  type DigestWorkspacePreference,
  type LinkedAccount,
  type ProviderAccountInfo,
  type SessionUser,
} from "./auth-client";
import { githubMarkSvg } from "./brand-icons";
import type { SlackLink } from "./slack-connect";
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
  /** Null when the preferences request failed. An empty list means no memberships. */
  digestWorkspaces: DigestWorkspacePreference[] | null;
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
  fetchImpl?: typeof fetch,
): Promise<ProfilePageData> {
  if (!cookie.trim()) {
    return {
      user: null,
      currentToken: null,
      accounts: null,
      githubInfo: null,
      sessions: null,
      digestWorkspaces: null,
    };
  }

  const [sessionResult, accounts, sessions, digestWorkspaces] = await Promise.all([
    getSession(authOrigin, { cookie, fetchImpl }),
    listAccounts(authOrigin, { cookie, fetchImpl }),
    listSessions(authOrigin, { cookie, fetchImpl }),
    listDigestPreferences(authOrigin, { cookie, fetchImpl }),
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
        fetchImpl,
      })
    : null;

  return { user, currentToken, accounts, githubInfo, sessions, digestWorkspaces };
}

function digestChecked(on: boolean): string {
  return on ? " checked" : "";
}

/**
 * One table row per workspace, one checkbox column per digest. The admin
 * pulse cell is a dash unless the membership is an admin or owner. Each
 * checkbox carries its own aria-label because the column header alone
 * doesn't name the workspace. Server-safe.
 */
export function renderWeeklyDigestHtml(workspaces: DigestWorkspacePreference[]): string {
  if (workspaces.length === 0) {
    return `<p class="muted settings-note">Join a workspace to get a weekly digest.</p>`;
  }
  const rows = workspaces
    .map((workspace) => {
      const name = escapeHtml(workspace.name || workspace.slug);
      const orgId = escapeHtml(workspace.organizationId);
      const admin = workspace.admin
        ? `<input type="checkbox" data-digest="admin" data-org-id="${orgId}" aria-label="Admin pulse for ${name}"${digestChecked(workspace.notifyWeeklyWorkspaceDigest)} />`
        : `<span class="digest-table__na" title="For workspace admins">—</span>`;
      return `<tr>
        <th scope="row"><span class="digest-table__name">${name}</span> <span class="digest-table__role">${escapeHtml(workspace.role)}</span></th>
        <td class="digest-table__toggle"><input type="checkbox" data-digest="member" data-org-id="${orgId}" aria-label="Weekly summary for ${name}"${digestChecked(workspace.notifyWeeklyDigest)} /></td>
        <td class="digest-table__toggle">${admin}</td>
      </tr>`;
    })
    .join("");
  return `<table class="digest-table">
    <thead><tr><th scope="col">Workspace</th><th scope="col" class="digest-table__toggle">Weekly summary</th><th scope="col" class="digest-table__toggle">Admin pulse</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
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

/** Where "Add to Slack" starts the app's OAuth install (apps/slack). */
export const SLACK_INSTALL_URL = "https://agents.uploads.sh/slack/install";

/**
 * The Slack section's body on /account/profile: one row per connected Slack
 * account with a Disconnect button, or, with none, how to connect. `null`
 * (the links request failed) gets a retry-later line.
 */
export function renderSlackLinksHtml(links: SlackLink[] | null): string {
  if (links === null) {
    return `<p class="muted settings-note">Couldn’t load your Slack connections.</p>`;
  }
  if (links.length === 0) {
    return `<div class="slack-empty">
      <p class="settings-note">Get a Slack message when an upload is held for review, and approve it without leaving Slack. Add the uploads.sh app to your Slack workspace, then press <strong>Connect uploads.sh</strong> on the app’s <strong>Home</strong> tab.</p>
      <p class="slack-empty__actions">
        <a class="text-btn text-btn--boxed" href="${SLACK_INSTALL_URL}">Add to Slack</a>
        <a class="text-btn" href="/docs/slack">How it works</a>
      </p>
    </div>`;
  }
  return `<ul class="detail-list" id="slack-links-list">${links
    .map((link) => {
      const needsUpdate = link.missingScopes.length > 0;
      const meta = needsUpdate
        ? "Needs updated Slack permissions for held-upload messages"
        : `Connected ${formatSessionTime(link.linkedAt)}`;
      const update = needsUpdate
        ? `<a class="text-btn text-btn--boxed" href="${SLACK_INSTALL_URL}">Update permissions</a>`
        : "";
      return `<li>
            <div class="detail-main">
              <div class="detail-title">
                <span>${escapeHtml(link.teamName ?? "Slack workspace")}</span>
                <span class="ul-badge ul-badge--ok">Connected</span>
              </div>
              <div class="detail-meta">${escapeHtml(meta)}</div>
            </div>
            <div class="detail-action">
              ${update}
              <button type="button" class="text-btn text-btn--boxed" data-slack-unlink data-team-id="${escapeHtml(link.teamId)}" data-slack-user-id="${escapeHtml(link.slackUserId)}">Disconnect</button>
            </div>
          </li>`;
    })
    .join("")}</ul>`;
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
