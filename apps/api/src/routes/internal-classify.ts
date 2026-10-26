/**
 * `POST /internal/classify` — uploads-mcp hands over a file it just stored
 * (issue #1148), so hosted MCP uploads are classified, and held, here: this
 * worker already has the OpenRouter key and the Flagship, Images, email,
 * and Slack bindings, so uploads-mcp needs only its `API` service binding
 * rather than copies of them.
 *
 * Body: the stored bytes, with their `Content-Type`. Query: `workspace`,
 * `key`, and `enforceHold=1` when a flagged result should hold the file.
 * Answers 202 at once and classifies in `waitUntil`; classification fails
 * open, so the caller has nothing to retry.
 *
 * Guard: host `api.internal`, which only a service binding can send (see
 * internal-slack.ts). Every other host, an unknown workspace, or a bad key
 * gets a bare 404.
 */
import { NotFoundError } from "@uploads/errors";
import { Hono } from "hono";
import { scheduleFileClassification } from "../classifier";
import { badKey } from "../files-core";
import { loadWorkspaceRecord, type WorkspaceVars } from "../workspace";
import { INTERNAL_API_HOST } from "./internal-slack";

export const internalClassify = new Hono<WorkspaceVars>().post("/", async (c) => {
  if (new URL(c.req.url).hostname !== INTERNAL_API_HOST) throw new NotFoundError();
  const workspaceName = c.req.query("workspace") ?? "";
  const key = c.req.query("key") ?? "";
  if (!workspaceName || !key || badKey(key)) throw new NotFoundError();
  const ws = await loadWorkspaceRecord(c.env, workspaceName);
  if (!ws) throw new NotFoundError();
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const scheduled = scheduleFileClassification(
    c.env,
    ws,
    workspaceName,
    key,
    bytes,
    c.req.header("Content-Type") ?? "application/octet-stream",
    (promise) => c.executionCtx.waitUntil(promise),
    { enforceHold: c.req.query("enforceHold") === "1" },
  );
  return c.json({ scheduled }, 202);
});
