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
import { badKey } from "../files-core";
import { memberWorkspaceOr404 } from "../org-workspaces";
import { approveUpload } from "../upload-hold-service";
import { loadWorkspaceRecord, type WorkspaceVars } from "../workspace";

export const INTERNAL_API_HOST = "api.internal";

const TEAM_ID = /^[TE][A-Z0-9]{2,20}$/;
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,20}$/;
const WORKSPACE = /^[a-z0-9-]{1,64}$/;

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
  });
