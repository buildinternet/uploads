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
 *   (`slack_workspace_bindings`, #1165), newest first, and returns only files
 *   the public share page would show: not private, not held.
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
import { SEARCH_NAME_MAX } from "../file-search";
import { badKey } from "../files-core";
import { memberWorkspaceOr404 } from "../org-workspaces";
import { objectPublicUrls, resolveObjectLaneWithHead, storage } from "../storage";
import { heldKeysAmong } from "../upload-hold-read";
import { approveUpload, memberName } from "../upload-hold-service";
import { objectVisibility } from "../visibility";
import { loadWorkspaceRecord, type WorkspaceVars } from "../workspace";

export const INTERNAL_API_HOST = "api.internal";

const TEAM_ID = /^[TE][A-Z0-9]{2,20}$/;
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,20}$/;
const WORKSPACE = /^[a-z0-9-]{1,64}$/;

/** Bound workspaces searched per command; more than this is unusual. */
const SEARCH_MAX_WORKSPACES = 5;
/** Results returned overall: a handful, newest first. */
const SEARCH_RESULTS = 5;
/**
 * Name matches gathered per workspace before sorting by upload time. The
 * storage walk yields keys in name order, so this is how far "newest" can
 * see; past it the reply says it only looked at the first matches.
 */
const SEARCH_SCAN_MAX = 200;
/** Newest candidates per workspace checked for visibility (one HEAD each). */
const SEARCH_CANDIDATES = 10;
/** Derived posters and CLI reports; never listed (files-core's INTERNAL_KEY_PREFIX). */
const INTERNAL_KEY_PREFIX = "_internal/";

export interface SlackSearchResult {
  workspace: string;
  key: string;
  /** Public URL to draw as a thumbnail; images only. */
  imageUrl?: string;
  /** Upload time (ms since epoch), when storage reports one. */
  uploaded?: number;
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
    const by = await memberName(c.env, link.user_id);
    const result = await approveUpload(c.env, record, workspace, key, by);
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
        const store = await storage(c.env, record);
        const found: { key: string; uploaded: number }[] = [];
        for await (const file of store.search(term, {
          match: "substring",
          caseInsensitive: true,
          maxResults: SEARCH_SCAN_MAX,
        })) {
          if (file.key.startsWith(INTERNAL_KEY_PREFIX)) continue;
          found.push({ key: file.key, uploaded: file.lastModified ?? 0 });
        }
        found.sort((a, b) => b.uploaded - a.uploaded);
        const held = await heldKeysAmong(
          c.env,
          workspace,
          found.slice(0, SEARCH_CANDIDATES).map((m) => m.key),
        );
        // Same gate as the public share page: it must have a public URL and
        // not be marked private. One HEAD per candidate.
        const visible = await Promise.all(
          found
            .slice(0, SEARCH_CANDIDATES)
            .filter((m) => !held.has(m.key))
            .map(async (m) => {
              const lane = await resolveObjectLaneWithHead(c.env, record, m.key);
              if (!lane) return null;
              const urls = objectPublicUrls(c.env, lane.config, m.key);
              if (!urls.url || objectVisibility(lane.head.metadata ?? undefined)) return null;
              const hit: SlackSearchResult = { workspace, key: m.key };
              if (lane.head.type.startsWith("image/")) hit.imageUrl = urls.embedUrl ?? urls.url;
              if (m.uploaded) hit.uploaded = m.uploaded;
              return hit;
            }),
        );
        return {
          hits: visible.filter((v): v is SlackSearchResult => v !== null),
          more: found.length >= SEARCH_SCAN_MAX,
        };
      }),
    );
    const all = perWorkspace
      .flatMap((p) => p.hits)
      .sort((a, b) => (b.uploaded ?? 0) - (a.uploaded ?? 0));
    console.log({ event: "slack_search", workspaces: bound.length, results: all.length });
    return c.json({
      bound: true,
      results: all.slice(0, SEARCH_RESULTS),
      // Only the walk's cap makes "newest" uncertain; more visible matches
      // than shown is the normal case and needs no note.
      truncated: perWorkspace.some((p) => p.more),
    });
  });
