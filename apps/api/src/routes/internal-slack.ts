/**
 * Calls from uploads-slack (apps/slack) over its `API` service binding,
 * never from the public internet.
 *
 * - `POST /internal/slack/approve` — someone pressed **Approve** on a held
 *   upload's Slack DM (`slack-hold-notify.ts`). uploads-slack has already
 *   checked Slack's request signature, so `teamId` + `slackUserId` name a
 *   real Slack user. This route maps them to the uploads.sh account through
 *   `slack_user_links`, requires that account to still be a member of the
 *   workspace, and approves exactly as `POST /v1/workspaces/:ws/files/approve`
 *   would for them.
 *
 * - `POST /internal/slack/search` — `/uploads search <term>` from a full
 *   member of a Slack workspace (uploads-slack has already checked the
 *   signature and that the person isn't a guest). Searches filenames in
 *   every uploads.sh workspace bound to that Slack team
 *   (`slack_workspace_bindings`, #1165) and returns only files the public
 *   share page would show: not private, not held.
 *
 * Guard: the binding addresses `api.internal`. Public traffic only reaches
 * this worker through the api.uploads.sh Custom Domain (or web's `/api`
 * proxy, which keeps the public host), so a request whose URL host is
 * `api.internal` can only have come over a service binding. Every other
 * host gets the same 404 as an unknown path. The same check guards
 * uploads-slack's own `/slack/internal/*` routes.
 *
 * Every not-linked, not-a-member, or bad-shape case answers 404 with no
 * detail, so the route can't be used to probe links or memberships.
 */
import { NotFoundError } from "@uploads/errors";
import { Hono } from "hono";
import { dbFor } from "../db-session";
import { searchFilesByNameAndMeta, SEARCH_NAME_MAX } from "../file-search";
import { badKey } from "../files-core";
import { memberWorkspaceOr404 } from "../org-workspaces";
import { objectPublicUrls, resolveObjectLaneWithHead } from "../storage";
import { heldKeysAmong } from "../upload-hold-read";
import { approveUpload } from "../upload-hold-service";
import { objectVisibility } from "../visibility";
import { loadWorkspaceRecord, type WorkspaceVars } from "../workspace";

export const INTERNAL_API_HOST = "api.internal";

const TEAM_ID = /^[TE][A-Z0-9]{2,20}$/;
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,20}$/;
const WORKSPACE = /^[a-z0-9-]{1,64}$/;

/** Bound workspaces searched per command; more than this is unusual. */
const SEARCH_MAX_WORKSPACES = 5;
/** Matches returned per workspace, and overall. */
const SEARCH_PAGE_SIZE = 10;

export interface SlackSearchResult {
  workspace: string;
  key: string;
}

function notFound(): NotFoundError {
  return new NotFoundError();
}

export const internalSlack = new Hono<WorkspaceVars>()
  .use("*", async (c, next) => {
    if (new URL(c.req.url).hostname !== INTERNAL_API_HOST) throw notFound();
    await next();
  })
  .post("/approve", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const teamId = typeof body?.teamId === "string" ? body.teamId : "";
    const slackUserId = typeof body?.slackUserId === "string" ? body.slackUserId : "";
    const workspace = typeof body?.workspace === "string" ? body.workspace : "";
    const key = typeof body?.key === "string" ? body.key : "";
    if (
      !TEAM_ID.test(teamId) ||
      !SLACK_USER_ID.test(slackUserId) ||
      !WORKSPACE.test(workspace) ||
      badKey(key)
    ) {
      throw notFound();
    }
    const link = await dbFor(c.env)
      .prepare(
        `SELECT l.user_id
           FROM slack_user_links l
           INNER JOIN user u ON u.id = l.user_id
          WHERE l.team_id = ? AND l.slack_user_id = ? AND COALESCE(u.banned, 0) = 0`,
      )
      .bind(teamId, slackUserId)
      .first<{ user_id: string }>();
    if (!link) throw notFound();
    await memberWorkspaceOr404(c.env, link.user_id, workspace);
    const record = await loadWorkspaceRecord(c.env, workspace);
    if (!record) throw notFound();
    const result = await approveUpload(c.env, record, workspace, key);
    console.log({ event: "upload_approved_from_slack", workspace, approved: result.approved });
    return c.json({ key, ...result });
  })
  .post("/search", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const teamId = typeof body?.teamId === "string" ? body.teamId : "";
    const term = typeof body?.term === "string" ? body.term.trim().toLowerCase() : "";
    if (!TEAM_ID.test(teamId) || !term || term.length > SEARCH_NAME_MAX) throw notFound();
    const db = dbFor(c.env);
    const { results: bound } = await db
      .prepare(
        `SELECT b.workspace
           FROM slack_workspace_bindings b
           INNER JOIN slack_installations i ON i.team_id = b.team_id
          WHERE b.team_id = ? AND i.revoked_at IS NULL
          ORDER BY b.workspace
          LIMIT ?`,
      )
      .bind(teamId, SEARCH_MAX_WORKSPACES)
      .all<{ workspace: string }>();
    if (bound.length === 0) return c.json({ bound: false, results: [], truncated: false });

    const perWorkspace = await Promise.all(
      bound.map(async ({ workspace }): Promise<{ hits: SlackSearchResult[]; more: boolean }> => {
        const record = await loadWorkspaceRecord(c.env, workspace);
        if (!record) return { hits: [], more: false };
        const { matches, truncated } = await searchFilesByNameAndMeta(c.env, record, workspace, {
          nameTerm: term,
          pageSize: SEARCH_PAGE_SIZE,
        });
        const held = await heldKeysAmong(
          c.env,
          workspace,
          matches.map((m) => m.key),
        );
        // Same gate as the public share page: it must have a public URL and
        // not be marked private. One HEAD per match, at most SEARCH_PAGE_SIZE.
        const visible = await Promise.all(
          matches
            .filter((m) => !held.has(m.key))
            .map(async (m) => {
              const lane = await resolveObjectLaneWithHead(c.env, record, m.key);
              if (!lane || !objectPublicUrls(c.env, lane.config, m.key).url) return null;
              if (objectVisibility(lane.head.metadata ?? undefined)) return null;
              return { workspace, key: m.key };
            }),
        );
        return { hits: visible.filter((v): v is SlackSearchResult => v !== null), more: truncated };
      }),
    );
    const all = perWorkspace.flatMap((p) => p.hits);
    console.log({ event: "slack_search", workspaces: bound.length, results: all.length });
    return c.json({
      bound: true,
      results: all.slice(0, SEARCH_PAGE_SIZE),
      truncated: all.length > SEARCH_PAGE_SIZE || perWorkspace.some((p) => p.more),
    });
  });
