/**
 * Experimental LLM file classifier (Workers AI via AI Gateway).
 *
 * After a successful `putObject`, a Flagship-allowlisted workspace can get
 * server-owned `ai.*` labels (`ai.tags`, `ai.summary`, `ai.kind`,
 * `ai.classifier`) so agents can organize uploads later. Off by default:
 * Flagship `llm-file-classifier` fails closed and is the sole allowlist
 * (targeting context `{ org, workspace }` = the workspace slug).
 * `llmClassifierEnabled === false` is an optional hard off; `undefined`
 * does not block. Fail-open: classifier errors never fail the upload.
 * Presigned (`POST /sign`) uploads never reach this hook.
 */

import { setServerFileMetadata } from "./file-metadata";
import { dbFor } from "./db-session";
import { uploadKind } from "./guards";
import type { WorkspaceRecord } from "./workspace";

/** Flagship flag. Default `false`; evaluation errors are treated as off. */
export const CLASSIFIER_FLAG = "llm-file-classifier";

/** Written to `ai.classifier` so agents can tell schema versions apart. */
export const CLASSIFIER_VERSION = "v1";

/** Vision-capable Workers AI model for raster images. */
export const CLASSIFIER_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

/** Cheap text model for filenames, MIME types, and short text excerpts. */
export const CLASSIFIER_TEXT_MODEL = "@cf/meta/llama-3.2-3b-instruct";

/** Skip vision on images larger than this — cost/latency cap. */
export const CLASSIFIER_MAX_IMAGE_BYTES = 512 * 1024;

/** Max characters of a text file sent to the model. */
export const CLASSIFIER_MAX_TEXT_CHARS = 1500;

/** Bound the model call so a hung gateway cannot pin the isolate. */
export const CLASSIFIER_TIMEOUT_MS = 8_000;

/** Server-owned rows this module writes. */
export const CLASSIFIER_META_KEYS = ["ai.tags", "ai.summary", "ai.kind", "ai.classifier"] as const;

const VISION_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

const KIND_ALLOWLIST = new Set([
  "screenshot",
  "photo",
  "diagram",
  "document",
  "code",
  "ui",
  "other",
]);

const TAG_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_TAGS = 8;

export const CLASSIFIER_PROMPT = [
  "Classify this uploaded file for later search and organization.",
  'Reply with JSON only: {"tags":["kebab-case"],"summary":"one short sentence","kind":"screenshot|photo|diagram|document|code|ui|other"}',
  "Rules: 3-8 lowercase kebab-case tags; summary max 140 ASCII characters;",
  "describe visual or document structure, not secrets.",
  "Do not transcribe emails, tokens, names, passwords, or credentials.",
  "kind must be one of the listed values.",
].join(" ");

export type ClassifierWaitUntil = (promise: Promise<unknown>) => void;

export interface ClassifierModelRequest {
  model: string;
  prompt: string;
  /** Raster image bytes for vision models. Never log this field. */
  image?: Uint8Array;
}

export type ClassifierRun = (req: ClassifierModelRequest) => Promise<unknown>;

/**
 * Flagship targeting attributes for this experiment. `org` is the workspace
 * slug today (Better Auth org slug ≈ workspace name) so rules can allowlist
 * without an AUTH hop on the upload path. Both keys are the same string.
 */
export function classifierEvaluationContext(
  ws: Pick<WorkspaceRecord, "name">,
  workspaceName: string,
): { org: string; workspace: string } {
  const slug = ws.name?.trim() || workspaceName;
  return { org: slug, workspace: slug };
}

/**
 * Every kill switch, cheapest first. Flagship is the sole allowlist
 * (default off; Demo adds targeting rules). `llmClassifierEnabled === false`
 * is a workspace-level hard off; `undefined`/`true` do not block.
 */
export async function classificationAllowed(
  env: Env,
  ws: Pick<WorkspaceRecord, "llmClassifierEnabled" | "name">,
  workspaceName: string,
): Promise<boolean> {
  if (!env.AI) return false;
  if (ws.llmClassifierEnabled === false) return false;
  if (!env.FLAGS) return false;
  try {
    const context = classifierEvaluationContext(ws, workspaceName);
    if (!(await env.FLAGS.getBooleanValue(CLASSIFIER_FLAG, false, context))) return false;
  } catch {
    return false;
  }
  return true;
}

export function classifierGatewayId(env: Env): string {
  const id = env.AI_GATEWAY_ID?.trim();
  return id && id.length > 0 ? id : "uploads-classifier";
}

/**
 * Build the model request. Images under the size cap use the vision model;
 * text files send a short excerpt; everything else is filename + MIME only.
 * Never attaches raw bytes for SVG (active content) or oversized images.
 */
export function buildClassifierRequest(
  key: string,
  contentType: string,
  bytes: Uint8Array,
): ClassifierModelRequest {
  const filename = key.split("/").pop() || key;
  const header = `${CLASSIFIER_PROMPT}\n\nfilename: ${filename}\ncontent-type: ${contentType}`;

  if (VISION_TYPES.has(contentType) && bytes.byteLength <= CLASSIFIER_MAX_IMAGE_BYTES) {
    return {
      model: CLASSIFIER_VISION_MODEL,
      prompt: header,
      image: bytes,
    };
  }

  let extra = "";
  if (isSafeTextExcerptType(contentType) && bytes.byteLength > 0) {
    const excerpt = textExcerpt(bytes);
    if (excerpt) extra = `\n\nexcerpt:\n${excerpt}`;
  } else if (uploadKind(contentType) === "image" && bytes.byteLength > CLASSIFIER_MAX_IMAGE_BYTES) {
    extra = `\n\nnote: image skipped (over ${CLASSIFIER_MAX_IMAGE_BYTES} bytes); classify from filename and type only.`;
  }

  return {
    model: CLASSIFIER_TEXT_MODEL,
    prompt: header + extra,
  };
}

function isSafeTextExcerptType(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType === "application/json";
}

/** First N chars of UTF-8 text, dropping NUL-looking binary. */
export function textExcerpt(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength === 0) return undefined;
  const slice = bytes.subarray(0, CLASSIFIER_MAX_TEXT_CHARS * 4);
  if (slice.includes(0)) return undefined;
  const decoded = new TextDecoder("utf-8").decode(slice);
  const trimmed = decoded.replace(/[^\x20-\x7E\n\t]/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > CLASSIFIER_MAX_TEXT_CHARS
    ? trimmed.slice(0, CLASSIFIER_MAX_TEXT_CHARS)
    : trimmed;
}

/** Pull a JSON object out of a model reply (raw or fenced). */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export function parseClassifierOutput(raw: string): Record<string, string> | null {
  const json = extractJsonObject(raw);
  if (!json) return null;

  const tags = normalizeTags(json.tags);
  const summary = normalizeSummary(json.summary);
  const kind = normalizeKind(json.kind);
  if (tags.length === 0 && !summary && !kind) return null;

  const meta: Record<string, string> = { "ai.classifier": CLASSIFIER_VERSION };
  if (tags.length > 0) meta["ai.tags"] = tags.join(",");
  if (summary) meta["ai.summary"] = summary;
  if (kind) meta["ai.kind"] = kind;
  return meta;
}

function normalizeTags(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tag = item
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
    if (!TAG_RE.test(tag) || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function normalizeSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ascii = value
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!ascii) return undefined;
  return ascii.length > 200 ? ascii.slice(0, 200) : ascii;
}

function normalizeKind(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const kind = value.trim().toLowerCase();
  return KIND_ALLOWLIST.has(kind) ? kind : undefined;
}

export function extractModelText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const rec = result as Record<string, unknown>;
  if (typeof rec.response === "string") return rec.response;
  if (typeof rec.description === "string") return rec.description;
  if (typeof rec.result === "string") return rec.result;
  return "";
}

/**
 * Default runner: Workers AI binding, always via AI Gateway when `env.AI`
 * is present. Does not log image bytes or excerpts.
 */
export function workersAiClassifierRun(env: Env): ClassifierRun {
  return async (req) => {
    if (!env.AI) throw new Error("AI binding missing");
    const input: Record<string, unknown> = {
      prompt: req.prompt,
      max_tokens: 256,
    };
    if (req.image) {
      // Workers AI vision models take a number[] of bytes.
      input.image = Array.from(req.image);
    }
    return env.AI.run(req.model, input, {
      gateway: {
        id: classifierGatewayId(env),
        skipCache: true,
      },
    });
  };
}

export async function classifyAndStore(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  deps?: { timeoutMs?: number; run?: ClassifierRun },
): Promise<Record<string, string> | undefined> {
  try {
    if (!(await classificationAllowed(env, ws, workspaceName))) return undefined;
    const run = deps?.run ?? workersAiClassifierRun(env);
    const timeoutMs = deps?.timeoutMs ?? CLASSIFIER_TIMEOUT_MS;
    const request = buildClassifierRequest(key, contentType, bytes);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      run(request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("classifier timed out")), timeoutMs);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
    const meta = parseClassifierOutput(extractModelText(result));
    if (!meta) return undefined;
    await setServerFileMetadata(dbFor(env), workspaceName, key, meta);
    return meta;
  } catch (err) {
    console.error({ event: "classifier_failed", workspace: workspaceName, key, err });
    return undefined;
  }
}

/**
 * Fire-and-forget after a successful put. REST passes `executionCtx.waitUntil`
 * so the isolate stays alive; callers without a ctx (MCP/ingest/tests) skip
 * rather than block the upload.
 */
export function scheduleFileClassification(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  waitUntil?: ClassifierWaitUntil,
): void {
  if (!waitUntil) return;
  // Cheap local gates only — Flagship is async and lives inside classifyAndStore.
  if (!env.AI) return;
  if (ws.llmClassifierEnabled === false) return;
  const work = classifyAndStore(env, ws, workspaceName, key, bytes, contentType);
  try {
    waitUntil(work);
  } catch {
    // no executionCtx — drop the work rather than fail the upload
  }
}
