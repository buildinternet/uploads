/**
 * Spans for the mention agent, named and labelled the way Cloudflare's
 * Agents dashboard reads them (OpenTelemetry GenAI conventions): one
 * `invoke_agent` span per mention, with a `chat` span per model call and an
 * `execute_tool` span per tool. Token counts go on the `chat` spans, so the
 * dashboard can total them per agent and per trace.
 *
 * Tracing is turned on with `observability.traces` in wrangler.jsonc.
 * Without it, or where the runtime has no tracing API, the work just runs.
 *
 * Only ids, counts, model names and tool arguments (search words and
 * labels) are recorded: never the question, the thread, or file contents.
 */
import { tracing } from "cloudflare:workers";

export type SpanAttributes = Record<string, string | number | boolean | undefined>;

export interface AgentSpan {
  setAttributes(attributes: SpanAttributes): unknown;
}

const NO_SPAN: AgentSpan = { setAttributes() {} };

/** Runs `work` inside a span called `name`, starting with `attributes`. */
export function inSpan<T>(
  name: string,
  attributes: SpanAttributes,
  work: (span: AgentSpan) => Promise<T>,
): Promise<T> {
  if (typeof tracing?.enterSpan !== "function") return work(NO_SPAN);
  return tracing.enterSpan(name, (span) => {
    span.setAttributes(attributes);
    return work(span);
  });
}
