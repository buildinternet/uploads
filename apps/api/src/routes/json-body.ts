import { ValidationError } from "@uploads/errors";
import type { Context } from "hono";
import type { WorkspaceVars } from "../workspace";

/** Parse a request body as a JSON object, rejecting arrays, `null`, and non-objects. */
export async function jsonBody(c: Context<WorkspaceVars>): Promise<Record<string, unknown>> {
  const body = await c.req.json<unknown>().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new ValidationError("Expected a JSON object.");
  return body as Record<string, unknown>;
}
