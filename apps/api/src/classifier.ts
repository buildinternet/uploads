/**
 * Experimental LLM file classifier (OpenRouter Decisions, called directly).
 *
 * After a successful `putObject`, a Flagship-allowlisted workspace can get
 * server-owned `ai.*` labels (`ai.kind`, `ai.surface`, `ai.screen`,
 * `ai.classifier`) so agents can organize uploads later. Off by default:
 * Flagship `llm-file-classifier` fails closed and is the sole allowlist
 * (targeting context `{ org, workspace }` = the workspace slug).
 * `llmClassifierEnabled === false` is an optional hard off; `undefined`
 * does not block. Fail-open: classifier errors never fail the upload.
 * Presigned (`POST /sign`) uploads never reach this hook.
 *
 * One Decisions call when the provider can see an image. The model picks
 * `kind`, `surface`, and `screen` from the closed enums, plus four
 * internal safety flags (`rating`, `content`, `secret`, `pii`). Flag
 * lifetime is `SAFETY_FLAG_KEYS`. Decisions models do not write free
 * text, so this path does not write `ai.tags` or `ai.summary`.
 *
 * Default model is the OpenRouter alias `~typesafe/jev-latest`. A PNG or
 * JPEG that already fits Jev's pixel window and the byte cap goes in
 * `state` as an `image_url` part (`ai.classifier=v5`), next to a short
 * fact list. A PNG, JPEG, WebP, GIF, or AVIF that does not fit is scaled
 * with the Images binding (`env.IMAGES`) into that window first
 * (`ai.classifier=v6`). The fact list keeps the original dimensions.
 * Images below Jev's window are not upscaled. `fit=scale-down` matches
 * the thumbnail transform.
 *
 * The model is not called without those pixels. A no-image file writes
 * `ai.classifier=skipped` and `ai.skip`, and nothing else. Reasons are
 * `small`, `unsupported`, `resize_failed`, and `resize_timeout`. `small`
 * is a trivially small image (either known side under 64 px, or an image
 * file under 2 KiB), on Jev or Luna. Unknown dimensions do not count as
 * small. A skip removes a previous kind, surface, and screen. It does
 * not write safety values. New bytes clear those rows before this runs,
 * so a skip leaves them clear. Identical bytes keep them.
 *
 * The resize has its own timeout (`CLASSIFIER_RESIZE_TIMEOUT_MS`). The
 * Decisions call keeps `CLASSIFIER_TIMEOUT_MS`. A slow resize cannot
 * spend the model's budget. Either timeout fails open.
 *
 * Optional Luna path (`ai.classifier=v4`): `CLASSIFIER_PROVIDER=luna` or
 * Flagship `llm-file-classifier-luna` (default off) selects
 * `openai/gpt-6-luna-decisions` on the same endpoint. Luna does not use
 * the resize. It accepts WebP and is not held to Jev's pixel window, so
 * a screenshot under the byte cap can still be seen when the flag is on.
 * A Luna file with no acceptable image is `unsupported`. Unset provider
 * and a flag that is off stay on Jev Latest.
 *
 * Both providers `POST https://openrouter.ai/api/alpha/decisions` with
 * `OPENROUTER_API_KEY`. The Cloudflare AI Gateway `openrouter` provider is
 * based at `https://openrouter.ai/api/v1`, so a gateway request for
 * `alpha/decisions` hits `/api/v1/alpha/decisions` and returns 404. Do not
 * send this call through `env.AI.gateway()`. A missing key skips
 * classification. The weekly digest still uses the Workers AI binding.
 */

import {
  SAFETY_FLAG_KEYS,
  deleteServerFileMetadataKeys,
  setServerFileMetadata,
} from "./file-metadata";
import { dbFor } from "./db-session";
import { detectImageDimensions, uploadKind } from "./guards";
import type { WorkspaceRecord } from "./workspace";

/** Flagship flag. Default `false`; evaluation errors are treated as off. */
export const CLASSIFIER_FLAG = "llm-file-classifier";

/**
 * Flagship flag that selects the Luna Decisions try for one workspace.
 * Default `false`. Evaluation errors stay on the Jev Latest path.
 */
export const CLASSIFIER_LUNA_FLAG = "llm-file-classifier-luna";

/**
 * Written to `ai.classifier` on the Jev Latest path when the original
 * bytes are sent. `v3` was the Llama-describe plus Workers AI Jev hybrid,
 * which did not send pixels. `v6` is the resized path.
 */
export const CLASSIFIER_VERSION = "v5";

/**
 * Written to `ai.classifier` when the bytes sent to Jev came from the
 * Images binding (a downscale, a recompress, or a WebP/GIF/AVIF still).
 * Distinct from `v5` so a resized row is recognizable.
 */
export const CLASSIFIER_RESIZED_VERSION = "v6";

/**
 * Written to `ai.classifier` when Luna Decisions runs, so a try is distinct
 * from Jev Latest in stored metadata.
 */
export const CLASSIFIER_LUNA_VERSION = "v4";

/**
 * Written to `ai.classifier` when the model is not called. Distinct from
 * `v4`/`v5`/`v6`, which mean a Decisions call ran. Paired with `ai.skip`.
 */
export const CLASSIFIER_SKIPPED = "skipped";

/** Written to `ai.skip` when the image is too small to be worth a call. */
export const CLASSIFIER_SKIP_SMALL = "small";

/**
 * Written to `ai.skip` when the file cannot be sent as an image this
 * provider accepts, and a resize is not the path to one.
 */
export const CLASSIFIER_SKIP_UNSUPPORTED = "unsupported";

/** Written to `ai.skip` when a resize was required and did not produce an image. */
export const CLASSIFIER_SKIP_RESIZE_FAILED = "resize_failed";

/** Written to `ai.skip` when the resize budget runs out. */
export const CLASSIFIER_SKIP_RESIZE_TIMEOUT = "resize_timeout";

/**
 * Either known edge below this skips the model. 64 px is a common icon
 * size and is well under Jev's 256 px minimum, so the pixels cannot be a
 * screenshot Jev could read. The edge is exclusive: 64 px still classifies
 * when the file is also large enough.
 */
export const CLASSIFIER_SKIP_MIN_EDGE = 64;

/**
 * Image files under this many bytes skip the model. 2 KiB. A tracking
 * pixel and a tiny icon sit under it. A screenshot does not. A file of
 * exactly this size still classifies.
 */
export const CLASSIFIER_SKIP_MIN_BYTES = 2 * 1024;

/**
 * Workers AI catalog id for weekly-digest curation. File classification
 * does not call this model. The digest runner still passes it to `env.AI`.
 */
export const CLASSIFIER_DECISION_MODEL = "typesafe/jev";

/**
 * OpenRouter alias for the current Jev release. Tracks the newest Jev that
 * accepts text and images on the Decisions API.
 */
export const CLASSIFIER_JEV_MODEL = "~typesafe/jev-latest";

/**
 * OpenRouter model id for the Luna try. Same Decisions API, wider image
 * acceptance than Jev's pixel window.
 */
export const CLASSIFIER_LUNA_MODEL = "openai/gpt-6-luna-decisions";

/**
 * Decisions lives at `/api/alpha/decisions`, not under `/api/v1`.
 * `https://openrouter.ai/api/v1/alpha/decisions` is the gateway 404.
 */
export const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

/** Decision provider. `jev` is the default. `luna` is the try. */
export const CLASSIFIER_PROVIDERS = ["jev", "luna"] as const;
export type ClassifierProvider = (typeof CLASSIFIER_PROVIDERS)[number];

/** Skip image bytes above this — cost and request-size cap. */
export const CLASSIFIER_MAX_IMAGE_BYTES = 512 * 1024;

/**
 * Images binding input ceiling (`input()` accepts up to 20 MB). A larger
 * file is `ai.skip=resize_failed` instead of throwing inside the binding.
 */
export const CLASSIFIER_TRANSFORM_MAX_INPUT_BYTES = 20 * 1024 * 1024;

/**
 * JPEG qualities for a classifier copy, tried in order. 82 matches the
 * thumbnail transform (`thumb-url.ts`). 60 is the retry when 82 is still
 * over the byte cap. A PNG upload tries a PNG encode first, so UI text
 * stays lossless when the result fits.
 */
export const CLASSIFIER_JPEG_QUALITIES = [82, 60] as const;

/** Below this confidence the decision model's answer is dropped. */
export const CLASSIFIER_MIN_CONFIDENCE = 0.5;

/**
 * Lower bound for `high` on a safety-flag confidence bucket. Inclusive.
 * 0.85 is the bar a later access policy can treat as actionable. Jev's
 * confidence is calibrated, so this means the chosen option is clearly ahead.
 */
export const CLASSIFIER_CONFIDENCE_HIGH = 0.85;

/**
 * Lower bound for `medium`. Inclusive. At or above this, and below
 * `CLASSIFIER_CONFIDENCE_HIGH`, the bucket is `medium`. From
 * `CLASSIFIER_MIN_CONFIDENCE` up to this bound the bucket is `low`.
 * 0.70 sits clearly above the write floor and below the action bar.
 */
export const CLASSIFIER_CONFIDENCE_MEDIUM = 0.7;

/** Coarse bucket stored on `ai.<flag>.confidence`. */
export type ConfidenceBucket = "high" | "medium" | "low";

/**
 * Map a stored answer's confidence onto `high` / `medium` / `low`.
 * Callers only pass a confidence that already cleared the write floor.
 */
export function confidenceBucket(confidence: number): ConfidenceBucket {
  if (confidence >= CLASSIFIER_CONFIDENCE_HIGH) return "high";
  if (confidence >= CLASSIFIER_CONFIDENCE_MEDIUM) return "medium";
  return "low";
}

/** Bound the Decisions call so a hung provider cannot pin the isolate. */
export const CLASSIFIER_TIMEOUT_MS = 8_000;

/**
 * Bound the Images resize on its own. A slow transform must not consume
 * `CLASSIFIER_TIMEOUT_MS`.
 */
export const CLASSIFIER_RESIZE_TIMEOUT_MS = 8_000;

/**
 * Jev image window, inclusive, from the OpenRouter multimodal Decisions
 * guide. An image outside it is not sent. A copy that can be scaled down
 * into the window is resized first. Anything else is a skip.
 */
export const JEV_MIN_IMAGE_EDGE = 256;
export const JEV_MAX_IMAGE_EDGE = 1_568;
export const JEV_MIN_IMAGE_PIXELS = 78_400;
export const JEV_MAX_IMAGE_PIXELS = 2_458_624;

/** Jev reads PNG and JPEG only. Luna also reads WebP. Other types are skipped. */
const JEV_IMAGE_TYPES = new Set(["image/png", "image/jpeg"]);
const LUNA_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

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

/**
 * Closed enum for `ai.rating`. Sexual content only. Violence is `safe`
 * here; `ai.content` says why a file is unsafe.
 */
export const RATING_CRITERIA: Record<string, string> = {
  safe: "No sexual content. Violence, text, and ordinary product UI are safe on this question.",
  suggestive: "Sexual innuendo, revealing clothing, or partial nudity that is not explicit.",
  explicit: "Nudity, a sex act, or pornography.",
};

/**
 * Closed enum for `ai.content`. The subject that makes a file unsafe.
 * Independent of `ai.rating`.
 */
export const CONTENT_CRITERIA: Record<string, string> = {
  none: "Ordinary content: a product screenshot, a document, or a photo with no unsafe subject.",
  sexual: "Nudity, a sex act, or other sexual content.",
  violence: "Physical harm that is not graphic gore.",
  gore: "Graphic injury, blood, or mutilation.",
  drugs: "Illegal drug use or drug paraphernalia as a subject.",
  hate: "A slur or a hate symbol targeting a protected group.",
  self_harm: "Suicide or self-injury.",
  other: "An unsafe subject that the other values do not fit.",
};

/**
 * Closed enum for `ai.secret`. Credentials that grant access. Kept apart
 * from `ai.pii` so a name or an email cannot fill this field.
 */
export const SECRET_CRITERIA: Record<string, string> = {
  none: "No credential that grants access. A username, a display name, or an email address is not a secret. A masked or empty secret field is none.",
  api_key: "An API key, client secret, or similar application credential.",
  password: "A password or passphrase, including one visible in a field.",
  private_key: "A private key or the private half of a certificate.",
  token: "A bearer token, session secret, access token, or refresh token.",
  connection_string: "A database or service URL that embeds a credential.",
  other: "Another credential that grants access and does not fit the other values.",
};

/**
 * Closed enum for `ai.pii`. Personal data that is the subject of the file.
 * Signed-in chrome (a header name or email) is `none`, so a normal UI
 * screenshot is not flagged.
 */
export const PII_CRITERIA: Record<string, string> = {
  none: "No personal data as the subject. A signed-in user's name, avatar, or email that appears only as interface chrome (a header, a nav bar, or an account menu) is none. An empty field labeled Email is none. A display name alone is none.",
  contact:
    "An email address, phone number, or street address that is content of the screen, such as a form, a directory, a message, or a shipping block. Not a name or email that only labels the signed-in account in the chrome.",
  identity_document: "A passport, driver's license, or other government identity document.",
  financial: "A payment card number or a bank account number.",
  other:
    "Other personal data, such as a government identifier or a medical record. A display name alone is not this.",
};

/**
 * One entry per closed question. Allowlists and `parseJevAnswers` both
 * read this map, so a new question is a change here.
 */
const CLASSIFIER_FIELDS: Record<
  string,
  { instructions: string; criteria: Record<string, string> }
> = {
  kind: {
    instructions: "What kind of file is this?",
    criteria: KIND_CRITERIA,
  },
  surface: {
    instructions:
      "Which device surface does the content show? Judge from the aspect ratio, the pixel width, and any visible device or window chrome.",
    criteria: SURFACE_CRITERIA,
  },
  screen: {
    instructions:
      "Which product screen does the content show? Pick `other` when the file is not an interface.",
    criteria: SCREEN_CRITERIA,
  },
  rating: {
    instructions:
      "Rate the sexual content. Pick `safe` when there is none. Violence without sexual content is `safe`; the content question covers it.",
    criteria: RATING_CRITERIA,
  },
  content: {
    instructions:
      "What is the main unsafe subject, if any? Pick `none` for an ordinary file, including a normal product screenshot. This question is separate from the sexual rating.",
    criteria: CONTENT_CRITERIA,
  },
  secret: {
    instructions:
      "Does this file show a credential that grants access to a system? Pick `none` for a masked or empty secret field, and for a username, a display name, or an email. Do not treat personal data as a secret; that is a different question.",
    criteria: SECRET_CRITERIA,
  },
  pii: {
    instructions:
      "Does this file show personal data about a person? Pick `none` for a normal product screenshot, including one that shows the signed-in user's own name or email only in the header, nav, or account menu. An empty email field is `none`. Do not treat an API key, password, or other access credential as personal data; that is a different question.",
    criteria: PII_CRITERIA,
  },
};

const CLASSIFIER_ALLOWLISTS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(CLASSIFIER_FIELDS).map(([id, field]) => [
    id,
    new Set(Object.keys(field.criteria)),
  ]),
);

export type ClassifierWaitUntil = (promise: Promise<unknown>) => void;

/** A Decisions choice question. */
export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

/**
 * Image part for the Decisions `state` array. This is the Chat Completions
 * shape. `{ type: "input_image", image_url: "data:..." }` is not an image
 * input on this API.
 */
export interface DecisionImagePart {
  type: "image_url";
  image_url: { url: string };
}

/** One Decisions call. `image` is omitted when the model cannot take the bytes. */
export interface ClassifierDecideRequest {
  stage: "decide";
  model: string;
  state: ClassifierState;
  image?: DecisionImagePart;
  questions: Record<string, JevChoiceQuestion>;
}

export type ClassifierRequest = ClassifierDecideRequest;

export type ClassifierRun = (
  req: ClassifierRequest,
  opts?: { signal?: AbortSignal },
) => Promise<unknown>;

/**
 * Text facts handed to the decision model. The OpenRouter runner turns this
 * into a string in the `state` array. It never carries raw bytes.
 */
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
 * Every kill switch, cheapest first. A missing OpenRouter key skips the
 * call. Flagship is the sole allowlist (default off). `llmClassifierEnabled
 * === false` is a workspace-level hard off; `undefined`/`true` do not block.
 */
export async function classificationAllowed(
  env: Env,
  ws: Pick<WorkspaceRecord, "llmClassifierEnabled" | "name">,
  workspaceName: string,
): Promise<boolean> {
  if (!env.OPENROUTER_API_KEY?.trim()) return false;
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
 * `CLASSIFIER_PROVIDER` when it is `jev` or `luna`. Anything else (unset,
 * blank, unknown) defers to the Luna flag.
 */
export function classifierProviderFromEnv(
  value: string | undefined,
): ClassifierProvider | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (trimmed === "luna" || trimmed === "jev") return trimmed;
  return undefined;
}

/**
 * Which decision model to run. An explicit env pin wins, so a try can be
 * forced on or pinned back to Jev without waiting on Flagship. Otherwise
 * `llm-file-classifier-luna` may select Luna for one workspace. A missing
 * flag or a thrown evaluation stays on Jev — the default path must not
 * move because Flagship blipped.
 */
export async function resolveClassifierProvider(
  env: Env,
  ws: Pick<WorkspaceRecord, "name">,
  workspaceName: string,
): Promise<ClassifierProvider> {
  const pinned = classifierProviderFromEnv(env.CLASSIFIER_PROVIDER);
  if (pinned) return pinned;
  if (!env.FLAGS) return "jev";
  try {
    const context = classifierEvaluationContext(ws, workspaceName);
    if (await env.FLAGS.getBooleanValue(CLASSIFIER_LUNA_FLAG, false, context)) return "luna";
  } catch {
    return "jev";
  }
  return "jev";
}

/** True when both edges and the pixel count sit inside Jev's inclusive window. */
export function jevAcceptsDimensions(width: number, height: number): boolean {
  if (width < JEV_MIN_IMAGE_EDGE || height < JEV_MIN_IMAGE_EDGE) return false;
  if (width > JEV_MAX_IMAGE_EDGE || height > JEV_MAX_IMAGE_EDGE) return false;
  const pixels = width * height;
  return pixels >= JEV_MIN_IMAGE_PIXELS && pixels <= JEV_MAX_IMAGE_PIXELS;
}

/**
 * Size of `width`×`height` after `fit=scale-down` into the 1,568 px box.
 * Returns undefined when that copy still cannot enter Jev's window: the
 * source is too small to upscale (we do not enlarge), or the aspect ratio
 * is too extreme to keep both edges inside the window.
 */
export function jevScaleDownFit(
  width: number,
  height: number,
): { width: number; height: number } | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return undefined;
  }
  const scale = Math.min(1, JEV_MAX_IMAGE_EDGE / width, JEV_MAX_IMAGE_EDGE / height);
  const fittedWidth = Math.min(JEV_MAX_IMAGE_EDGE, Math.max(1, Math.round(width * scale)));
  const fittedHeight = Math.min(JEV_MAX_IMAGE_EDGE, Math.max(1, Math.round(height * scale)));
  if (!jevAcceptsDimensions(fittedWidth, fittedHeight)) return undefined;
  return { width: fittedWidth, height: fittedHeight };
}

/**
 * Why a measured image cannot be scaled down into the window. A source
 * that is already inside the max box is too small. Anything else is too
 * large or too extreme to fit without cropping or upscaling.
 */
export function jevUnfittableNote(width: number, height: number): string {
  const withinMax =
    width <= JEV_MAX_IMAGE_EDGE &&
    height <= JEV_MAX_IMAGE_EDGE &&
    width * height <= JEV_MAX_IMAGE_PIXELS;
  return withinMax
    ? "image skipped: below jev pixel limits"
    : "image skipped: outside jev pixel limits";
}

/**
 * Facts that accompany an image. Pixel dimensions come from the header.
 * This is not a classification by itself: the caller sends it only next
 * to pixels the provider can see.
 */
export function buildClassifierState(
  key: string,
  contentType: string,
  bytes: Uint8Array,
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

  return state;
}

/**
 * Why this image is too small to call the model, or undefined when size
 * alone does not skip it. Non-images return undefined. Unknown dimensions
 * do not count as a short edge. The byte floor still applies to them, so
 * a 1×1 file whose header we cannot read is skipped, and a large
 * unmeasured image is not.
 */
export function trivialImageSkip(contentType: string, bytes: Uint8Array): string | undefined {
  if (uploadKind(contentType) !== "image") return undefined;
  if (bytes.byteLength < CLASSIFIER_SKIP_MIN_BYTES) return CLASSIFIER_SKIP_SMALL;
  const dims = detectImageDimensions(bytes, contentType);
  if (!dims) return undefined;
  if (dims.width < CLASSIFIER_SKIP_MIN_EDGE || dims.height < CLASSIFIER_SKIP_MIN_EDGE) {
    return CLASSIFIER_SKIP_SMALL;
  }
  return undefined;
}

/** Within 5% of square counts as square; the rest is a plain comparison. */
function aspectOf(width: number, height: number): "portrait" | "landscape" | "square" {
  const ratio = width / height;
  if (ratio > 1.05) return "landscape";
  if (ratio < 0.95) return "portrait";
  return "square";
}

/**
 * The closed-enum questions the decision model answers, in one request.
 * Safety flags are separate questions so a PII hit cannot become a secret,
 * and a violent image is not scored as sexually explicit.
 */
export function buildClassifierQuestions(): Record<string, JevChoiceQuestion> {
  return Object.fromEntries(
    Object.entries(CLASSIFIER_FIELDS).map(([id, field]) => [
      id,
      {
        type: "choice" as const,
        instructions: field.instructions,
        criteria: { ...field.criteria },
      },
    ]),
  );
}

/**
 * Inline image for this provider, or a note explaining why the bytes stay
 * off the request. Non-images return neither.
 */
export function buildDecisionImage(
  provider: ClassifierProvider,
  contentType: string,
  bytes: Uint8Array,
): { image?: DecisionImagePart; note?: string } {
  const allowed = provider === "luna" ? LUNA_IMAGE_TYPES : JEV_IMAGE_TYPES;
  if (!allowed.has(contentType)) {
    if (uploadKind(contentType) !== "image") return {};
    return {
      note:
        provider === "luna"
          ? "image skipped: luna accepts png, jpeg, and webp"
          : "image skipped: jev accepts png and jpeg",
    };
  }
  if (bytes.byteLength === 0) return {};
  if (bytes.byteLength > CLASSIFIER_MAX_IMAGE_BYTES) {
    return { note: `image skipped: over ${CLASSIFIER_MAX_IMAGE_BYTES} bytes` };
  }
  const dims = detectImageDimensions(bytes, contentType);
  if (!dims) return { note: "image skipped: dimensions unknown" };
  if (provider === "jev" && !jevAcceptsDimensions(dims.width, dims.height)) {
    return { note: "image skipped: outside jev pixel limits" };
  }
  return {
    image: {
      type: "image_url",
      image_url: { url: `data:${contentType};base64,${bytesToBase64(bytes)}` },
    },
  };
}

/** Formats the Images binding can turn into a PNG or JPEG Jev will accept. */
const JEV_TRANSFORM_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/avif",
]);

/** One encode attempt. The binding wrapper turns this into `transform` + `output`. */
export interface ClassifierResizeRequest {
  width: number;
  height: number;
  fit: "scale-down";
  format: "image/jpeg" | "image/png";
  quality?: number;
}

/**
 * Seam around `env.IMAGES`. The binding has a local subset and no Miniflare
 * fake that returns classifier-sized bytes, so tests pass their own.
 */
export interface ClassifierImageTransform {
  resize(bytes: Uint8Array, request: ClassifierResizeRequest): Promise<Uint8Array>;
}

/** Result of choosing the image part for one Decisions call. */
export interface PreparedClassifierImage {
  image?: DecisionImagePart;
  note?: string;
  /** True when `image` was produced by the Images binding rather than the upload. */
  resized: boolean;
  /**
   * Set when `image` is absent. `resize_timeout` is applied by the caller
   * when the resize budget fires before this returns.
   */
  skip?: typeof CLASSIFIER_SKIP_RESIZE_FAILED | typeof CLASSIFIER_SKIP_UNSUPPORTED;
}

function skippedImage(
  skip: NonNullable<PreparedClassifierImage["skip"]>,
  note?: string,
): PreparedClassifierImage {
  return { note, resized: false, skip };
}

/**
 * Encode ladder for one source. A PNG tries a lossless encode first so
 * screenshot text stays sharp when the result fits under the byte cap.
 * Every other transformable type becomes a JPEG. The box is the whole
 * Jev window; `scale-down` never enlarges.
 */
export function classifierResizeAttempts(contentType: string): ClassifierResizeRequest[] {
  const box = {
    width: JEV_MAX_IMAGE_EDGE,
    height: JEV_MAX_IMAGE_EDGE,
    fit: "scale-down" as const,
  };
  const attempts: ClassifierResizeRequest[] = [];
  if (contentType === "image/png") attempts.push({ ...box, format: "image/png" });
  for (const quality of CLASSIFIER_JPEG_QUALITIES) {
    attempts.push({ ...box, format: "image/jpeg", quality });
  }
  return attempts;
}

type EncodedForJev =
  | {
      ok: true;
      bytes: Uint8Array;
      contentType: "image/png" | "image/jpeg";
      width: number;
      height: number;
    }
  | { ok: false; reason: "over_cap" | "invalid" | "unfittable"; width?: number; height?: number };

/**
 * Run the encode ladder. A copy whose pixel size cannot enter the window
 * stops the ladder (a lower JPEG quality will not change that). A copy
 * that is only too large tries the next quality.
 */
export async function encodeForJevWindow(
  transform: ClassifierImageTransform,
  bytes: Uint8Array,
  contentType: string,
  signal?: AbortSignal,
): Promise<EncodedForJev> {
  let sawOverCap = false;
  for (const attempt of classifierResizeAttempts(contentType)) {
    if (signal?.aborted) throw new Error("classifier timed out");
    const out = await transform.resize(bytes, attempt);
    if (signal?.aborted) throw new Error("classifier timed out");
    const dims = detectImageDimensions(out, attempt.format);
    if (!dims || out.byteLength === 0) continue;
    if (!jevAcceptsDimensions(dims.width, dims.height)) {
      return { ok: false, reason: "unfittable", width: dims.width, height: dims.height };
    }
    if (out.byteLength > CLASSIFIER_MAX_IMAGE_BYTES) {
      sawOverCap = true;
      continue;
    }
    return {
      ok: true,
      bytes: out,
      contentType: attempt.format,
      width: dims.width,
      height: dims.height,
    };
  }
  return sawOverCap ? { ok: false, reason: "over_cap" } : { ok: false, reason: "invalid" };
}

/**
 * Image part for this provider. Jev may resize first. Luna never does: the
 * try is there to see the original pixels, including WebP and sizes outside
 * Jev's window. No image means a skip. Luna's skip is `unsupported`. Jev
 * uses `unsupported` when a resize cannot produce an acceptable image, and
 * `resize_failed` when a resize was required and did not.
 */
export async function prepareClassifierImage(
  provider: ClassifierProvider,
  contentType: string,
  bytes: Uint8Array,
  transform?: ClassifierImageTransform,
  signal?: AbortSignal,
): Promise<PreparedClassifierImage> {
  if (provider !== "jev") {
    const decision = buildDecisionImage(provider, contentType, bytes);
    if (decision.image) return { image: decision.image, resized: false };
    return skippedImage(CLASSIFIER_SKIP_UNSUPPORTED, decision.note);
  }

  const direct = buildDecisionImage("jev", contentType, bytes);
  if (direct.image) return { image: direct.image, resized: false };
  if (!JEV_TRANSFORM_TYPES.has(contentType) || bytes.byteLength === 0) {
    return skippedImage(CLASSIFIER_SKIP_UNSUPPORTED, direct.note);
  }

  const dims = detectImageDimensions(bytes, contentType);
  if (dims && !jevScaleDownFit(dims.width, dims.height)) {
    return skippedImage(CLASSIFIER_SKIP_UNSUPPORTED, jevUnfittableNote(dims.width, dims.height));
  }
  if (bytes.byteLength > CLASSIFIER_TRANSFORM_MAX_INPUT_BYTES) {
    return skippedImage(
      CLASSIFIER_SKIP_RESIZE_FAILED,
      "image skipped: image too large to transform",
    );
  }
  if (!transform) {
    const note =
      !dims && direct.note === "image skipped: dimensions unknown"
        ? direct.note
        : "image skipped: transform unavailable";
    return skippedImage(CLASSIFIER_SKIP_RESIZE_FAILED, note);
  }

  try {
    const encoded = await encodeForJevWindow(transform, bytes, contentType, signal);
    if (!encoded.ok) {
      if (encoded.reason === "unfittable" && encoded.width && encoded.height) {
        return skippedImage(
          CLASSIFIER_SKIP_RESIZE_FAILED,
          jevUnfittableNote(encoded.width, encoded.height),
        );
      }
      if (encoded.reason === "over_cap") {
        return skippedImage(
          CLASSIFIER_SKIP_RESIZE_FAILED,
          `image skipped: transformed image over ${CLASSIFIER_MAX_IMAGE_BYTES} bytes`,
        );
      }
      return skippedImage(CLASSIFIER_SKIP_RESIZE_FAILED, "image skipped: transform failed");
    }
    const decision = buildDecisionImage("jev", encoded.contentType, encoded.bytes);
    if (!decision.image) {
      return skippedImage(
        CLASSIFIER_SKIP_RESIZE_FAILED,
        decision.note ?? "image skipped: transform failed",
      );
    }
    const label = encoded.contentType === "image/png" ? "png" : "jpeg";
    return {
      image: decision.image,
      resized: true,
      note: `image prepared for classification: ${encoded.width}x${encoded.height} ${label}`,
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    console.error({ event: "classifier_image_transform_failed", err });
    return skippedImage(CLASSIFIER_SKIP_RESIZE_FAILED, "image skipped: transform failed");
  }
}

/**
 * Wraps `env.IMAGES`. One fresh stream per attempt because `input()`
 * consumes it. `anim: false` keeps a GIF or AVIF first frame as a still.
 * Does not log the bytes.
 */
export function imagesClassifierTransform(images: ImagesBinding): ClassifierImageTransform {
  return {
    async resize(bytes, request) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      const result = await images
        .input(stream)
        .transform({ width: request.width, height: request.height, fit: request.fit })
        .output({
          format: request.format,
          anim: false,
          ...(request.quality !== undefined ? { quality: request.quality } : {}),
        });
      return new Uint8Array(await new Response(result.image()).arrayBuffer());
    },
  };
}

export function buildDecideRequest(
  state: ClassifierState,
  provider: ClassifierProvider = "jev",
  image?: DecisionImagePart,
): ClassifierDecideRequest {
  return {
    stage: "decide",
    model: provider === "luna" ? CLASSIFIER_LUNA_MODEL : CLASSIFIER_JEV_MODEL,
    state,
    ...(image ? { image } : {}),
    questions: buildClassifierQuestions(),
  };
}

/**
 * Decisions `state` array: one plain-text fact list, then the image part
 * when there is one. Image parts have to sit in that top-level array.
 * Nesting them inside the fact object hides them from every model except
 * Jev, and the `input_image` shape is not an image input at all.
 */
export function formatDecisionState(
  state: ClassifierState,
  image?: DecisionImagePart,
): Array<string | DecisionImagePart> {
  const lines = [
    `filename: ${state.filename}`,
    `content_type: ${state.content_type}`,
    `byte_size: ${state.byte_size}`,
  ];
  if (state.image_width !== undefined) lines.push(`image_width: ${state.image_width}`);
  if (state.image_height !== undefined) lines.push(`image_height: ${state.image_height}`);
  if (state.aspect) lines.push(`aspect: ${state.aspect}`);
  if (state.excerpt) lines.push(`excerpt: ${state.excerpt}`);
  if (state.description) lines.push(`description: ${state.description}`);
  if (state.tags?.length) lines.push(`tags: ${state.tags.join(",")}`);
  if (state.summary) lines.push(`summary: ${state.summary}`);
  if (state.note) lines.push(`note: ${state.note}`);
  const text = lines.join("\n");
  return image ? [text, image] : [text];
}

/** Base64 without spreading the whole buffer into one `fromCharCode` call. */
function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Jev's answers, narrowed to the closed enums this module writes. An answer
 * is dropped when its confidence is under the threshold, when the choice is
 * not in the allowlist, or when the shape is not what the model documents.
 * A stored safety flag also writes `ai.<field>.confidence`. A dropped
 * answer omits both keys. A secret answer never fills `ai.pii`, and the
 * reverse is also true.
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

  for (const [field, allowlist] of Object.entries(CLASSIFIER_ALLOWLISTS)) {
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
    if (SAFETY_FLAG_KEYS.has(`ai.${field}`)) {
      meta[`ai.${field}.confidence`] = confidenceBucket(confidence);
    }
  }

  if (Object.keys(meta).length === 0) return null;
  return { meta, confidences };
}

/** A direct Decisions body, or one wrapped a level down. */
function findJevAnswers(result: unknown): Record<string, unknown> | null {
  if (!isPlainObject(result)) return null;
  if (isPlainObject(result.answers)) return result.answers;
  for (const wrapper of ["response", "result"]) {
    const inner = result[wrapper];
    if (isPlainObject(inner) && isPlainObject(inner.answers)) return inner.answers;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Weekly-digest runner: Workers AI binding, via AI Gateway when `env.AI`
 * is present. File classification does not use this. The catalog model is
 * not in `@cloudflare/workers-types`' `AiModelList`, so the call casts its
 * model name and input.
 */
export function workersAiClassifierRun(env: Env): ClassifierRun {
  return async (req) => {
    if (!env.AI) throw new Error("AI binding missing");
    const gateway = { id: classifierGatewayId(env), skipCache: true };
    const input = { state: req.state, questions: req.questions };
    return env.AI.run(req.model as never, input as never, { gateway });
  };
}

/**
 * File-classifier runner. One direct OpenRouter Decisions call. Does not
 * log image bytes, data URLs, or the API key. A missing key throws; callers
 * that classify an upload catch it and write nothing.
 */
export function openRouterDecisionsRun(env: Env): ClassifierRun {
  return async (req, opts) => {
    const apiKey = env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");

    if (!req.image) throw new Error("decisions call requires an image");

    const response = await fetch(OPENROUTER_DECISIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://uploads.sh",
        "X-Title": "uploads",
      },
      body: JSON.stringify({
        model: req.model,
        state: formatDecisionState(req.state, req.image),
        questions: req.questions,
      }),
      signal: opts?.signal,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // The status is the failure that matters.
      }
      throw new Error(`openrouter decisions failed: ${response.status}`);
    }
    return response.json();
  };
}

function classifierVersionMarker(provider: ClassifierProvider, resized: boolean): string {
  if (provider === "luna") return CLASSIFIER_LUNA_VERSION;
  return resized ? CLASSIFIER_RESIZED_VERSION : CLASSIFIER_VERSION;
}

/** Display labels a skip must not leave behind from an earlier classification. */
const CLASSIFIER_DISPLAY_KEYS = ["ai.kind", "ai.surface", "ai.screen"] as const;

function skipMeta(reason: string, provider: ClassifierProvider): Record<string, string> {
  // Two keys, and only these. A model miss writes nothing, so a lone
  // `ai.classifier` would look like a miss. Display and safety keys stay
  // off the write so a skip cannot put a stale flag back.
  console.log({ event: "classifier_skipped", reason, provider });
  return {
    "ai.classifier": CLASSIFIER_SKIPPED,
    "ai.skip": reason,
  };
}

async function storeSkip(
  env: Env,
  workspaceName: string,
  key: string,
  reason: string,
  provider: ClassifierProvider,
): Promise<Record<string, string>> {
  const db = dbFor(env);
  await deleteServerFileMetadataKeys(db, workspaceName, key, [...CLASSIFIER_DISPLAY_KEYS]);
  const meta = skipMeta(reason, provider);
  await setServerFileMetadata(db, workspaceName, key, meta);
  return meta;
}

async function storeDecision(
  env: Env,
  workspaceName: string,
  key: string,
  meta: Record<string, string>,
): Promise<Record<string, string>> {
  const db = dbFor(env);
  await deleteServerFileMetadataKeys(db, workspaceName, key, ["ai.skip"]);
  await setServerFileMetadata(db, workspaceName, key, meta);
  return meta;
}

function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  message: string,
): Promise<T> {
  void work.catch(() => {
    // The race already observed a timeout or a rejection.
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new Error(message));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function decideImage(
  run: ClassifierRun,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  minConfidence: number,
  provider: ClassifierProvider,
  signal: AbortSignal,
  prepared: PreparedClassifierImage & { image: DecisionImagePart },
): Promise<Record<string, string> | undefined> {
  const state = buildClassifierState(key, contentType, bytes);
  if (prepared.note) state.note = prepared.note;
  const request = buildDecideRequest(state, provider, prepared.image);
  const decided = parseJevAnswers(await run(request, { signal }), { minConfidence });

  const meta: Record<string, string> = {
    "ai.classifier": classifierVersionMarker(provider, prepared.resized),
    ...decided?.meta,
  };
  if (Object.keys(meta).length === 1) return undefined;
  console.log({
    event: "classifier_decided",
    provider,
    model: request.model,
    resized: prepared.resized,
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
  deps?: {
    timeoutMs?: number;
    resizeTimeoutMs?: number;
    run?: ClassifierRun;
    minConfidence?: number;
    transform?: ClassifierImageTransform;
  },
): Promise<Record<string, string> | undefined> {
  try {
    if (!(await classificationAllowed(env, ws, workspaceName))) return undefined;
    const provider = await resolveClassifierProvider(env, ws, workspaceName);
    const trivial = trivialImageSkip(contentType, bytes);
    if (trivial) return await storeSkip(env, workspaceName, key, trivial, provider);

    const transform =
      deps?.transform ?? (env.IMAGES ? imagesClassifierTransform(env.IMAGES) : undefined);
    const resizeController = new AbortController();
    const resizeTimeoutMs = deps?.resizeTimeoutMs ?? CLASSIFIER_RESIZE_TIMEOUT_MS;
    let prepared: PreparedClassifierImage;
    try {
      prepared = await withDeadline(
        prepareClassifierImage(provider, contentType, bytes, transform, resizeController.signal),
        resizeTimeoutMs,
        () => resizeController.abort(),
        "classifier resize timed out",
      );
    } catch (err) {
      const reason = resizeController.signal.aborted
        ? CLASSIFIER_SKIP_RESIZE_TIMEOUT
        : CLASSIFIER_SKIP_RESIZE_FAILED;
      if (!resizeController.signal.aborted) {
        console.error({ event: "classifier_image_transform_failed", err });
      }
      return await storeSkip(env, workspaceName, key, reason, provider);
    }

    if (!prepared.image) {
      return await storeSkip(
        env,
        workspaceName,
        key,
        prepared.skip ?? CLASSIFIER_SKIP_UNSUPPORTED,
        provider,
      );
    }

    const run = deps?.run ?? openRouterDecisionsRun(env);
    const timeoutMs = deps?.timeoutMs ?? CLASSIFIER_TIMEOUT_MS;
    const minConfidence = deps?.minConfidence ?? CLASSIFIER_MIN_CONFIDENCE;
    const modelController = new AbortController();
    const meta = await withDeadline(
      decideImage(run, key, bytes, contentType, minConfidence, provider, modelController.signal, {
        ...prepared,
        image: prepared.image,
      }),
      timeoutMs,
      () => modelController.abort(),
      "classifier timed out",
    );
    if (!meta) return undefined;
    return await storeDecision(env, workspaceName, key, meta);
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
  if (!env.OPENROUTER_API_KEY?.trim()) return;
  if (ws.llmClassifierEnabled === false) return;
  const work = classifyAndStore(env, ws, workspaceName, key, bytes, contentType);
  try {
    waitUntil(work);
  } catch {
    // no executionCtx — drop the work rather than fail the upload
  }
}
