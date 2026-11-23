/**
 * MCP Events on the hosted server (SEP-3415, webhook delivery only):
 * `events/list`, `events/subscribe` and `events/unsubscribe`. The rules,
 * storage and delivery live in `@uploads/api/mcp-events`, which the hold
 * service also calls when it emits `upload.held` and `upload.approved`.
 *
 * Attached only when the caller is a signed-in user who can read files, so a
 * workspace token never sees the capability. The capability goes under
 * `extensions` (the spec) and also as a top-level `events` key (what
 * ChatGPT reads, per its MCP Events guide).
 */
import { ProtocolError, type McpServer } from "@modelcontextprotocol/server";
import {
  EVENT_TYPES,
  EVENTS_EXTENSION_ID,
  McpEventsError,
  subscribeEvent,
  unsubscribeEvent,
  type EventsPrincipal,
} from "@uploads/api/mcp-events";

/** Pass-through params schema: the api module validates and reports InvalidParams itself. */
const anyParams = {
  "~standard": {
    version: 1 as const,
    vendor: "uploads",
    validate: (value: unknown) => ({ value: value ?? {} }),
  },
};

function toProtocolError(err: unknown): unknown {
  return err instanceof McpEventsError ? new ProtocolError(err.code, err.message, err.data) : err;
}

export function attachEvents(server: McpServer, env: Env, principal: EventsPrincipal): void {
  const low = server.server;
  low.registerCapabilities({
    extensions: { [EVENTS_EXTENSION_ID]: {} },
    ...({ events: {} } as Record<string, unknown>),
  });
  low.setRequestHandler("events/list", { params: anyParams }, () => ({
    resultType: "complete",
    events: [...EVENT_TYPES],
  }));
  low.setRequestHandler("events/subscribe", { params: anyParams }, async (params) => {
    try {
      return { ...(await subscribeEvent(env, principal, params)) };
    } catch (err) {
      throw toProtocolError(err);
    }
  });
  low.setRequestHandler("events/unsubscribe", { params: anyParams }, async (params) => {
    try {
      return { ...(await unsubscribeEvent(env, principal, params)) };
    } catch (err) {
      throw toProtocolError(err);
    }
  });
}
