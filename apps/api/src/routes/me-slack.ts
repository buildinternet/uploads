/**
 * Session-authenticated Slack user linking (`/me/slack/*`).
 *
 * uploads-slack (apps/slack) mints a single-use ticket when a Slack user who
 * isn't linked yet opens the app's Home tab, and sends them to
 * `uploads.sh/slack/connect?ticket=…`. That page previews the ticket here,
 * then the signed-in user's POST consumes it and records the link
 * (migration 20261018170000_slack_user_links.sql). Only the ticket's
 * base64url SHA-256 is stored; see apps/slack/src/links.ts `ticketHash`.
 *
 * Mounted under `me`, so `sessionAuth` + `requireSessionUser` already ran.
 * Every bad-shape, unknown, expired, or not-yours case is the same 404, so
 * these routes can't be used to probe for tickets or other users' links.
 */
import { NotFoundError } from "@uploads/errors";
import { Hono, type Context } from "hono";
import { dbFor } from "../db-session";
import { missingSlackScopes } from "../slack-scopes";
import type { SessionUser, SessionVars } from "../session-auth";

const TEAM_ID = /^[TE][A-Z0-9]{2,20}$/;
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,20}$/;
const TICKET = /^[A-Za-z0-9_-]{16,64}$/;

/** base64url(SHA-256(ticket)), no padding. Must match apps/slack's `ticketHash`. */
export async function slackTicketHash(ticket: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticket)),
  );
  let s = "";
  for (const byte of digest) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface TicketRow {
  team_id: string;
  team_name: string | null;
  slack_user_name: string | null;
  slack_user_id: string;
  expires_at: string;
}

function ticketNotFound(): NotFoundError {
  return new NotFoundError("This link is invalid or has expired.", {
    code: "slack_ticket_not_found",
  });
}

function linkNotFound(): NotFoundError {
  return new NotFoundError("Slack link not found.", { code: "slack_link_not_found" });
}

function sessionUser(c: Context<SessionVars>): SessionUser {
  const user = c.get("sessionUser");
  // requireSessionUser already guarantees this; keep the 404 shape uniform.
  if (!user) throw linkNotFound();
  return user;
}

function ticketParam(c: Context<SessionVars>): string {
  const ticket = c.req.param("ticket") ?? "";
  if (!TICKET.test(ticket)) throw ticketNotFound();
  return ticket;
}

/**
 * Asks uploads-slack to re-render this Slack user's Home tab, so it flips
 * between Connect and Disconnect without the user reopening it. Best effort
 * and after the response: the binding is absent in tests and local dev, and
 * a failure only leaves the old Home view up until the next open.
 */
function refreshSlackHome(c: Context<SessionVars>, teamId: string, slackUserId: string): void {
  const slack = (c.env as { SLACK?: Fetcher }).SLACK;
  if (!slack) return;
  let ctx: Context<SessionVars>["executionCtx"];
  try {
    ctx = c.executionCtx;
  } catch {
    return;
  }
  ctx.waitUntil(
    slack
      .fetch("https://slack.internal/slack/internal/home", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId, slackUserId }),
      })
      .then(() => undefined)
      .catch(() => undefined),
  );
}

export const meSlack = new Hono<SessionVars>()
  // Preview: who is this ticket for? Read-only.
  .get("/connect/:ticket", async (c) => {
    const hash = await slackTicketHash(ticketParam(c));
    const row = await dbFor(c.env)
      .prepare(
        `SELECT team_id, team_name, slack_user_id, slack_user_name, expires_at
           FROM slack_link_tickets
          WHERE ticket_hash = ? AND expires_at > ?`,
      )
      .bind(hash, new Date().toISOString())
      .first<TicketRow>();
    if (!row) throw ticketNotFound();
    return c.json({
      teamId: row.team_id,
      teamName: row.team_name,
      slackUserId: row.slack_user_id,
      slackUserName: row.slack_user_name,
      expiresAt: row.expires_at,
    });
  })

  // Consume the ticket and link the Slack user to the signed-in account.
  // The DELETE … RETURNING is the single-use guard: only one request can
  // remove the row, so a reused ticket 404s. Re-linking a Slack user that
  // already has a link replaces it — the ticket proves control of that
  // Slack user.
  .post("/connect/:ticket", async (c) => {
    const user = sessionUser(c);
    const hash = await slackTicketHash(ticketParam(c));
    const db = dbFor(c.env);
    const now = new Date().toISOString();
    const row = await db
      .prepare(
        `DELETE FROM slack_link_tickets
          WHERE ticket_hash = ? AND expires_at > ?
        RETURNING team_id, team_name, slack_user_id, slack_user_name, expires_at`,
      )
      .bind(hash, now)
      .first<TicketRow>();
    if (!row) throw ticketNotFound();
    await db.batch([
      db
        .prepare(
          `INSERT INTO slack_user_links (team_id, slack_user_id, user_id, user_email, linked_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (team_id, slack_user_id) DO UPDATE SET
             user_id = excluded.user_id,
             user_email = excluded.user_email,
             linked_at = excluded.linked_at`,
        )
        .bind(row.team_id, row.slack_user_id, user.id, user.email ?? null, now),
      // Lazy cleanup of other expired tickets; the expires index keeps it cheap.
      db.prepare("DELETE FROM slack_link_tickets WHERE expires_at <= ?").bind(now),
    ]);
    refreshSlackHome(c, row.team_id, row.slack_user_id);
    return c.json({
      teamId: row.team_id,
      teamName: row.team_name,
      slackUserId: row.slack_user_id,
      linked: true,
    });
  })

  // The signed-in user's own links, with each Slack workspace's name
  // (account settings lists them).
  .get("/links", async (c) => {
    const user = sessionUser(c);
    const { results } = await dbFor(c.env)
      .prepare(
        `SELECT l.team_id, l.slack_user_id, l.linked_at, i.team_name, i.scopes
           FROM slack_user_links l
           LEFT JOIN slack_installations i ON i.team_id = l.team_id
          WHERE l.user_id = ?
          ORDER BY l.linked_at DESC`,
      )
      .bind(user.id)
      .all<{
        team_id: string;
        slack_user_id: string;
        linked_at: string;
        team_name: string | null;
        scopes: string | null;
      }>();
    return c.json({
      links: results.map((r) => ({
        teamId: r.team_id,
        teamName: r.team_name,
        slackUserId: r.slack_user_id,
        linkedAt: r.linked_at,
        // Scopes the workspace's install hasn't approved yet; account
        // settings offers "Update permissions" when this isn't empty.
        missingScopes: r.scopes === null ? [] : missingSlackScopes(r.scopes),
      })),
    });
  })

  // Unlink. Only the account that owns the link can remove it here.
  .delete("/links/:teamId/:slackUserId", async (c) => {
    const user = sessionUser(c);
    const teamId = c.req.param("teamId");
    const slackUserId = c.req.param("slackUserId");
    if (!TEAM_ID.test(teamId) || !SLACK_USER_ID.test(slackUserId)) throw linkNotFound();
    const result = await dbFor(c.env)
      .prepare(
        "DELETE FROM slack_user_links WHERE team_id = ? AND slack_user_id = ? AND user_id = ?",
      )
      .bind(teamId, slackUserId, user.id)
      .run();
    if (!result.meta.changes) throw linkNotFound();
    refreshSlackHome(c, teamId, slackUserId);
    return c.body(null, 204);
  });
