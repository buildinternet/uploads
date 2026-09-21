/**
 * Experimental LLM file classifier (Workers AI via AI Gateway).
 *
 * After a successful `putObject`, a Flagship-allowlisted workspace can get
 * server-owned `ai.*` labels (`ai.tags`, `ai.summary`, `ai.kind`,
 * `ai.surface`, `ai.screen`, `ai.classifier`) so agents can organize uploads
 * later. Off by default:
 * Flagship `llm-file-classifier` fails closed and is the sole allowlist
 * (targeting context `{ org, workspace }` = the workspace slug).
 * `llmClassifierEnabled === false` is an optional hard off; `undefined`
 * does not block. Fail-open: classifier errors never fail the upload.
 * Presigned (`POST /sign`) uploads never reach this hook.
 *
 * Two stages (`ai.classifier=v3`):
 *
 * 1. **describe** — a vision model looks at a raster image under the size
 *    cap and returns free-text `description`, `tags`, and `summary`. Every
 *    other file type skips this stage, so it gets no tags and no summary.
 * 2. **decide** — `typesafe/jev` picks `kind`, `surface`, and `screen` from
 *    the closed enums and reports a calibrated confidence per answer. This
 *    stage always runs. An answer under `CLASSIFIER_MIN_CONFIDENCE` omits
 *    its key.
 *
 * Stage 1 is advisory: when it throws, stage 2 still runs on the file facts
 * alone. When stage 2 throws, the classifier writes nothing.
 */

import { setServerFileMetadata } from "./file-metadata";
import { dbFor } from "./db-session";
import { detectImageDimensions, uploadKind } from "./guards";
import type { WorkspaceRecord } from "./workspace";

/** Flagship flag. Default `false`; evaluation errors are treated as off. */
export const CLASSIFIER_FLAG = "llm-file-classifier";

/** Written to `ai.classifier` so agents can tell schema versions apart. */
export const CLASSIFIER_VERSION = "v3";

/** Vision-capable Workers AI model for raster images (stage 1). */
export const CLASSIFIER_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

/**
 * Closed-enum decision model (stage 2). Jev answers typed questions with a
 * calibrated confidence. Input-token priced; output tokens are free.
 */
export const CLASSIFIER_DECISION_MODEL = "typesafe/jev";

/** Skip vision on images larger than this — cost/latency cap. */
export const CLASSIFIER_MAX_IMAGE_BYTES = 512 * 1024;

/** Max characters of a text file sent to the model. */
export const CLASSIFIER_MAX_TEXT_CHARS = 1500;

/** Below this confidence the decision model's answer is dropped. */
export const CLASSIFIER_MIN_CONFIDENCE = 0.5;

/** Bound the whole pipeline so a hung gateway cannot pin the isolate. */
export const CLASSIFIER_TIMEOUT_MS = 8_000;

/** Server-owned rows this module writes. */
export const CLASSIFIER_META_KEYS = [
  "ai.tags",
  "ai.summary",
  "ai.kind",
  "ai.surface",
  "ai.screen",
  "ai.classifier",
] as const;

const VISION_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** Closed enum for `ai.kind`, with the criteria Jev decides against. */
export const KIND_CRITERIA: Record<string, string> = {
  screenshot: "A capture of a running application, website, or operating system window.",
  photo: "A camera photograph of the physical world, including people, places, and objects.",
  diagram: "A drawn chart, graph, flowchart, architecture sketch, or other explanatory figure.",
  document: "Prose, a report, a form, a slide, or a scan of printed text meant to be read.",
  code: "Source code, configuration, logs, or structured data such as JSON, YAML, or CSV.",
  ui: "A design or mockup of an interface that is not a capture of a running product.",
  other: "Anything the other values do not fit, including decorative or ambiguous files.",
};

/** Closed enum for `ai.surface` — the device the content targets. */
export const SURFACE_CRITERIA: Record<string, string> = {
  mobile:
    "A phone: a tall portrait frame (roughly 9:16 or narrower), a width near 400 CSS pixels, a status bar, or a bottom tab bar.",
  desktop:
    "A computer screen: a wide landscape frame (roughly 16:10 or wider), a window title bar, a sidebar, or a browser chrome.",
  tablet:
    "A tablet: a frame between phone and desktop proportions (roughly 3:4 to 4:3) with touch-sized controls.",
  unknown: "The file shows no device at all, or the evidence does not favor one device.",
};

/** Closed enum for `ai.screen` — the product screen the content shows. */
export const SCREEN_CRITERIA: Record<string, string> = {
  login: "Signing in to an existing account: an email or password field, or a sign-in button.",
  signup: "Creating a new account: a registration form, plan picker, or invite acceptance.",
  settings: "Configuration for an account, workspace, or application: toggles and preferences.",
  profile: "One person's identity: an avatar, a display name, a bio, or their own activity.",
  dashboard: "An overview home that summarizes several areas at once, often with cards.",
  analytics: "Charts, metrics, or reports as the main subject of the screen.",
  list: "A collection of comparable records: a table, a feed, a grid, or an inbox.",
  detail: "One record in depth, usually reached from a list.",
  form: "Data entry that is not sign-in or sign-up: fields, validation, and a submit button.",
  search: "A search box with its results or filters as the main subject.",
  modal: "A dialog, sheet, popover, or confirmation layered over another screen.",
  onboarding: "A first-run tour, setup wizard, or welcome step.",
  empty: "A screen with no data yet, showing placeholder art or a call to action.",
  error: "A failure state: an error page, an exception, a stack trace, or a failed request.",
  checkout: "Payment, billing, a cart, a subscription, or a pricing selection.",
  other: "A screen none of the other values describe, or a file that shows no screen.",
};

const KIND_ALLOWLIST = new Set(Object.keys(KIND_CRITERIA));
const SURFACE_ALLOWLIST = new Set(Object.keys(SURFACE_CRITERIA));
const SCREEN_ALLOWLIST = new Set(Object.keys(SCREEN_CRITERIA));

const TAG_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_TAGS = 5;

/** Stage 1 prompt. Describes the picture; it never picks an enum value. */
export const CLASSIFIER_PROMPT = [
  "Describe this uploaded image so another system can classify it.",
  'Reply with JSON only: {"description":"one or two sentences","tags":["kebab-case"],"summary":"one short sentence"}',
  "The description states what is visible and how it is laid out: device frame, page structure,",
  "controls, charts, and any product screen it resembles.",
  "Rules: 3-5 lowercase kebab-case tags (fewer is fine; do not invent filler);",
  "summary max 140 ASCII characters;",
  "describe visual or document structure, not secrets.",
  "Do not transcribe emails, tokens, names, passwords, or credentials.",
].join(" ");

export type ClassifierWaitUntil = (promise: Promise<unknown>) => void;

/** Stage 1: free-text description of a raster image. */
export interface ClassifierDescribeRequest {
  stage: "describe";
  model: string;
  prompt: string;
  /** Raster image bytes for vision models. Never log this field. */
  image?: Uint8Array;
}

/** A Jev question. Only `choice` questions are used today. */
export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

/** Stage 2: closed-enum decision over the facts gathered so far. */
export interface ClassifierDecideRequest {
  stage: "decide";
  model: string;
  state: ClassifierState;
  questions: Record<string, JevChoiceQuestion>;
}

export type ClassifierRequest = ClassifierDescribeRequest | ClassifierDecideRequest;

export type ClassifierRun = (req: ClassifierRequest) => Promise<unknown>;

/** Text-only facts handed to the decision model. Never carries raw bytes. */
export interface ClassifierState {
  filename: string;
  content_type: string;
  byte_size: number;
  image_width?: number;
  image_height?: number;
  aspect?: "portrait" | "landscape" | "square";
  excerpt?: string;
  description?: string;
  tags?: string[];
  summary?: string;
  note?: string;
}

/** Stage 1's parsed reply. Every field is optional — the model may skip one. */
export interface ClassifierDescription {
  description?: string;
  tags: string[];
  summary?: string;
}

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
 * Stage 1 request, or `undefined` when a generative pass adds nothing.
 * Only raster images under the size cap qualify, so SVG (active content)
 * and oversized images never attach raw bytes.
 */
export function buildDescribeRequest(
  key: string,
  contentType: string,
  bytes: Uint8Array,
): ClassifierDescribeRequest | undefined {
  if (!VISION_TYPES.has(contentType)) return undefined;
  if (bytes.byteLength > CLASSIFIER_MAX_IMAGE_BYTES) return undefined;
  const filename = key.split("/").pop() || key;
  return {
    stage: "describe",
    model: CLASSIFIER_VISION_MODEL,
    prompt: `${CLASSIFIER_PROMPT}\n\nfilename: ${filename}\ncontent-type: ${contentType}`,
    image: bytes,
  };
}

/**
 * The text-only facts stage 2 decides from. Pixel dimensions come from the
 * image header, so aspect ratio is available even when stage 1 is skipped.
 */
export function buildClassifierState(
  key: string,
  contentType: string,
  bytes: Uint8Array,
  described?: ClassifierDescription,
): ClassifierState {
  const state: ClassifierState = {
    filename: key.split("/").pop() || key,
    content_type: contentType,
    byte_size: bytes.byteLength,
  };

  const dims = detectImageDimensions(bytes, contentType);
  if (dims) {
    state.image_width = dims.width;
    state.image_height = dims.height;
    state.aspect = aspectOf(dims.width, dims.height);
  }

  if (isSafeTextExcerptType(contentType) && bytes.byteLength > 0) {
    const excerpt = textExcerpt(bytes);
    if (excerpt) state.excerpt = excerpt;
  } else if (uploadKind(contentType) === "image" && bytes.byteLength > CLASSIFIER_MAX_IMAGE_BYTES) {
    state.note = `image skipped: over ${CLASSIFIER_MAX_IMAGE_BYTES} bytes`;
  }

  if (described?.description) state.description = described.description;
  if (described?.tags.length) state.tags = described.tags;
  if (described?.summary) state.summary = described.summary;
  return state;
}

/** Within 5% of square counts as square; the rest is a plain comparison. */
function aspectOf(width: number, height: number): "portrait" | "landscape" | "square" {
  const ratio = width / height;
  if (ratio > 1.05) return "landscape";
  if (ratio < 0.95) return "portrait";
  return "square";
}

/** The three closed-enum questions Jev answers. */
export function buildClassifierQuestions(): Record<string, JevChoiceQuestion> {
  return {
    kind: {
      type: "choice",
      instructions: "What kind of file is this?",
      criteria: { ...KIND_CRITERIA },
    },
    surface: {
      type: "choice",
      instructions:
        "Which device surface does the content show? Judge from the aspect ratio, the pixel width, and any visible device or window chrome.",
      criteria: { ...SURFACE_CRITERIA },
    },
    screen: {
      type: "choice",
      instructions:
        "Which product screen does the content show? Pick `other` when the file is not an interface.",
      criteria: { ...SCREEN_CRITERIA },
    },
  };
}

export function buildDecideRequest(state: ClassifierState): ClassifierDecideRequest {
  return {
    stage: "decide",
    model: CLASSIFIER_DECISION_MODEL,
    state,
    questions: buildClassifierQuestions(),
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

/** Stage 1's JSON reply, normalized. Returns `null` when nothing survives. */
export function parseDescribeOutput(raw: string): ClassifierDescription | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  const description = normalizeSummary(json.description);
  const tags = normalizeTags(json.tags);
  const summary = normalizeSummary(json.summary);
  if (!description && tags.length === 0 && !summary) return null;
  return { description, tags, summary };
}

/**
 * Jev's answers, narrowed to the closed enums this module writes. An answer
 * is dropped when its confidence is under the threshold, when the choice is
 * not in the allowlist, or when the shape is not what the model documents.
 */
export function parseJevAnswers(
  result: unknown,
  opts?: { minConfidence?: number },
): { meta: Record<string, string>; confidences: Record<string, number> } | null {
  const minConfidence = opts?.minConfidence ?? CLASSIFIER_MIN_CONFIDENCE;
  const answers = findJevAnswers(result);
  if (!answers) return null;

  const meta: Record<string, string> = {};
  const confidences: Record<string, number> = {};
  const fields: [string, Set<string>][] = [
    ["kind", KIND_ALLOWLIST],
    ["surface", SURFACE_ALLOWLIST],
    ["screen", SCREEN_ALLOWLIST],
  ];

  for (const [field, allowlist] of fields) {
    const answer = answers[field];
    if (!isPlainObject(answer)) continue;
    const choice = answer.choice;
    const confidence = answer.confidence;
    if (typeof choice !== "string" || typeof confidence !== "number") continue;
    if (!Number.isFinite(confidence)) continue;
    confidences[field] = confidence;
    if (confidence < minConfidence) continue;
    const normalized = choice.trim().toLowerCase();
    if (!allowlist.has(normalized)) continue;
    meta[`ai.${field}`] = normalized;
  }

  if (Object.keys(meta).length === 0) return null;
  return { meta, confidences };
}

/** AI Gateway sometimes wraps the model payload; look one level down too. */
function findJevAnswers(result: unknown): Record<string, unknown> | null {
  if (!isPlainObject(result)) return null;
  if (isPlainObject(result.answers)) return result.answers;
  for (const wrapper of ["response", "result"]) {
    const inner = result[wrapper];
    if (isPlainObject(inner) && isPlainObject(inner.answers)) return inner.answers;
  }
  return null;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** String fields, or a plain object that is already the classifier JSON. */
function fieldAsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isPlainObject(value)) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export function extractModelText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!isPlainObject(result)) return "";

  const fromKnown =
    fieldAsText(result.response) || fieldAsText(result.description) || fieldAsText(result.result);
  if (fromKnown) return fromKnown;

  const first = Array.isArray(result.choices) ? result.choices[0] : undefined;
  if (isPlainObject(first)) {
    if (isPlainObject(first.message)) {
      const content = fieldAsText(first.message.content);
      if (content) return content;
    }
    if (typeof first.text === "string") return first.text;
  }

  return "";
}

/**
 * Default runner: Workers AI binding, always via AI Gateway when `env.AI`
 * is present. Does not log image bytes or excerpts.
 *
 * `typesafe/jev` is not in `@cloudflare/workers-types`' `AiModelList`, so
 * the decide call casts its model name and input rather than loosening the
 * whole binding's types.
 */
export function workersAiClassifierRun(env: Env): ClassifierRun {
  return async (req) => {
    if (!env.AI) throw new Error("AI binding missing");
    const gateway = { id: classifierGatewayId(env), skipCache: true };

    if (req.stage === "decide") {
      const input = { state: req.state, questions: req.questions };
      return env.AI.run(req.model as never, input as never, { gateway });
    }

    const input: Record<string, unknown> = { prompt: req.prompt, max_tokens: 256 };
    if (req.image) {
      // Workers AI vision models take a number[] of bytes.
      input.image = Array.from(req.image);
    }
    return env.AI.run(req.model as never, input as never, { gateway });
  };
}

/** Stage 1, best effort. A throw or an unusable reply is not fatal. */
async function describeFile(
  run: ClassifierRun,
  request: ClassifierDescribeRequest,
): Promise<ClassifierDescription | undefined> {
  try {
    const result = await run(request);
    return parseDescribeOutput(extractModelText(result)) ?? undefined;
  } catch {
    return undefined;
  }
}

async function runClassifierPipeline(
  run: ClassifierRun,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  minConfidence: number,
): Promise<Record<string, string> | undefined> {
  const describeRequest = buildDescribeRequest(key, contentType, bytes);
  const described = describeRequest ? await describeFile(run, describeRequest) : undefined;

  const state = buildClassifierState(key, contentType, bytes, described);
  const decided = parseJevAnswers(await run(buildDecideRequest(state)), { minConfidence });

  const meta: Record<string, string> = {
    "ai.classifier": CLASSIFIER_VERSION,
    ...decided?.meta,
  };
  if (described?.tags.length) meta["ai.tags"] = described.tags.join(",");
  if (described?.summary) meta["ai.summary"] = described.summary;

  if (Object.keys(meta).length === 1) return undefined;
  console.log({
    event: "classifier_decided",
    model: CLASSIFIER_DECISION_MODEL,
    confidences: decided?.confidences ?? {},
  });
  return meta;
}

export async function classifyAndStore(
  env: Env,
  ws: WorkspaceRecord,
  workspaceName: string,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  deps?: { timeoutMs?: number; run?: ClassifierRun; minConfidence?: number },
): Promise<Record<string, string> | undefined> {
  try {
    if (!(await classificationAllowed(env, ws, workspaceName))) return undefined;
    const run = deps?.run ?? workersAiClassifierRun(env);
    const timeoutMs = deps?.timeoutMs ?? CLASSIFIER_TIMEOUT_MS;
    const minConfidence = deps?.minConfidence ?? CLASSIFIER_MIN_CONFIDENCE;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One deadline for both stages, not one per call.
    const meta = await Promise.race([
      runClassifierPipeline(run, key, bytes, contentType, minConfidence),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("classifier timed out")), timeoutMs);
      }),
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
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
