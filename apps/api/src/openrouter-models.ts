/**
 * OpenRouter's public model list, narrowed to models the Slack mention agent
 * can run: image input and tool calls. Admin → Models offers these with
 * their prices. https://openrouter.ai/docs/api-reference/list-available-models
 */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export interface AgentModelOption {
  id: string;
  name: string;
  /** USD per million input tokens, or null when OpenRouter lists none. */
  inputPerMillion: number | null;
  /** USD per million output tokens. */
  outputPerMillion: number | null;
}

interface OpenRouterModel {
  id?: unknown;
  name?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  architecture?: { input_modalities?: unknown };
  supported_parameters?: unknown;
}

function perMillion(perToken: unknown): number | null {
  const n = typeof perToken === "string" ? Number(perToken) : NaN;
  // OpenRouter uses -1 for "varies" (routers); treat that as unknown.
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1_000_000 * 1000) / 1000 : null;
}

/** Models that take images and tools, cheapest input first. */
export function agentModelOptions(body: unknown): AgentModelOption[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const options: AgentModelOption[] = [];
  for (const m of data as OpenRouterModel[]) {
    if (typeof m.id !== "string") continue;
    const inputs = m.architecture?.input_modalities;
    const params = m.supported_parameters;
    if (!Array.isArray(inputs) || !inputs.includes("image")) continue;
    if (!Array.isArray(params) || !params.includes("tools")) continue;
    options.push({
      id: m.id,
      name: typeof m.name === "string" ? m.name : m.id,
      inputPerMillion: perMillion(m.pricing?.prompt),
      outputPerMillion: perMillion(m.pricing?.completion),
    });
  }
  return options.sort(
    (a, b) =>
      (a.inputPerMillion ?? Infinity) - (b.inputPerMillion ?? Infinity) || a.id.localeCompare(b.id),
  );
}

export async function fetchAgentModelOptions(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<AgentModelOption[]> {
  const res = await fetchImpl(OPENROUTER_MODELS_URL, {
    headers: { "HTTP-Referer": "https://uploads.sh", "X-Title": "uploads" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`openrouter models: ${res.status}`);
  return agentModelOptions(await res.json());
}
