/**
 * Repo-level managed-comment config parser/resolver (issue #307). The
 * published CLI (`@buildinternet/uploads`) cannot import this private
 * workspace package, so it carries its own byte-for-byte COPY at
 * packages/uploads/src/comment-config.ts. Kept in sync by
 * test/fixtures/comment-config-golden.json, asserted from both sides
 * (this package's index.test.ts and the CLI's comment-config.test.ts) —
 * change both copies together.
 */
import { parse as parseYaml } from "yaml";

export interface RepoCommentConfig {
  imageWidth?: "auto" | "full" | number;
  maxInlineImages?: number;
  metaPath?: boolean;
  metaState?: boolean;
  linkToFilePage?: boolean;
  note?: string;
}
export interface WorkspaceCommentDefaults {
  imageWidth?: "full" | number;
  maxInlineImages?: number;
  showMetadata?: boolean; // maps to BOTH metaPath and metaState
  linkToFilePage?: boolean;
  note?: string;
}
export interface ResolvedCommentOptions {
  imageWidth: "auto" | "full" | number;
  maxInlineImages: number;
  metaPath: boolean;
  metaState: boolean;
  linkToFilePage: boolean;
  note: string | null;
}
export type OptionSource = "repo" | "workspace" | "auto";

export const AUTO_COMMENT_OPTIONS: ResolvedCommentOptions = {
  imageWidth: "auto",
  maxInlineImages: 16, // MAX_INLINE_ATTACHMENT_IMAGES — renderer copies own the constant
  metaPath: true,
  metaState: true,
  linkToFilePage: true,
  note: null,
};

export const NOTE_MAX_CHARS = 500;
const WIDTH_MIN = 160;
const WIDTH_MAX = 1000;
const MAX_INLINE_MIN = 1;
const MAX_INLINE_MAX = 48;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

export function parseRepoCommentConfig(
  text: string,
  format: "yaml" | "json",
): { config: RepoCommentConfig | null; warnings: string[] } {
  const warnings: string[] = [];
  let root: unknown;
  try {
    root = format === "json" ? JSON.parse(text) : parseYaml(text);
  } catch {
    return { config: null, warnings: ["config file could not be parsed; ignoring it"] };
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    return { config: null, warnings };
  }
  const comment = (root as Record<string, unknown>).comment;
  if (typeof comment !== "object" || comment === null || Array.isArray(comment)) {
    return { config: null, warnings };
  }
  const c = comment as Record<string, unknown>;
  const config: RepoCommentConfig = {};

  // imageWidth: "auto" | "full" | finite number (clamped)
  if ("imageWidth" in c) {
    const v = c.imageWidth;
    if (v === "auto" || v === "full") config.imageWidth = v;
    else if (typeof v === "number" && Number.isFinite(v))
      config.imageWidth = clamp(v, WIDTH_MIN, WIDTH_MAX);
    else warnings.push(`imageWidth: expected "auto", "full", or a number; dropped`);
  }

  // maxInlineImages: finite number (clamped)
  if ("maxInlineImages" in c) {
    const v = c.maxInlineImages;
    if (typeof v === "number" && Number.isFinite(v))
      config.maxInlineImages = clamp(v, MAX_INLINE_MIN, MAX_INLINE_MAX);
    else warnings.push(`maxInlineImages: expected a number; dropped`);
  }

  // linkToFilePage: boolean
  if ("linkToFilePage" in c) {
    const v = c.linkToFilePage;
    if (typeof v === "boolean") config.linkToFilePage = v;
    else warnings.push(`linkToFilePage: expected a boolean; dropped`);
  }

  // meta.path / meta.state: booleans nested under `meta`
  if ("meta" in c) {
    const v = c.meta;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const meta = v as Record<string, unknown>;
      if ("path" in meta) {
        if (typeof meta.path === "boolean") config.metaPath = meta.path;
        else warnings.push(`meta.path: expected a boolean; dropped`);
      }
      if ("state" in meta) {
        if (typeof meta.state === "boolean") config.metaState = meta.state;
        else warnings.push(`meta.state: expected a boolean; dropped`);
      }
    } else {
      warnings.push(`meta: expected an object; dropped`);
    }
  }

  // note: non-empty trimmed string, max NOTE_MAX_CHARS (never truncated)
  if ("note" in c) {
    const v = c.note;
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length === 0) {
        // empty/whitespace note is treated as absent
      } else if (trimmed.length > NOTE_MAX_CHARS) {
        warnings.push(`note: longer than ${NOTE_MAX_CHARS} characters; dropped (not truncated)`);
      } else {
        config.note = trimmed;
      }
    } else {
      warnings.push(`note: expected a string; dropped`);
    }
  }

  return { config, warnings };
}

export function resolveCommentOptions(
  repo: RepoCommentConfig | null,
  ws: WorkspaceCommentDefaults | null,
): { options: ResolvedCommentOptions; source: Record<keyof ResolvedCommentOptions, OptionSource> } {
  const wsAsRepo: RepoCommentConfig = {
    ...(ws?.imageWidth !== undefined ? { imageWidth: ws.imageWidth } : {}),
    ...(ws?.maxInlineImages !== undefined ? { maxInlineImages: ws.maxInlineImages } : {}),
    ...(ws?.showMetadata !== undefined
      ? { metaPath: ws.showMetadata, metaState: ws.showMetadata }
      : {}),
    ...(ws?.linkToFilePage !== undefined ? { linkToFilePage: ws.linkToFilePage } : {}),
    ...(ws?.note ? { note: ws.note } : {}),
  };
  const options = { ...AUTO_COMMENT_OPTIONS };
  const source = Object.fromEntries(
    Object.keys(AUTO_COMMENT_OPTIONS).map((k) => [k, "auto"]),
  ) as Record<keyof ResolvedCommentOptions, OptionSource>;
  const apply = (cfg: RepoCommentConfig, from: OptionSource) => {
    for (const key of [
      "imageWidth",
      "maxInlineImages",
      "metaPath",
      "metaState",
      "linkToFilePage",
    ] as const) {
      if (cfg[key] !== undefined && source[key] === "auto") {
        (options as Record<string, unknown>)[key] = cfg[key];
        source[key] = from;
      }
    }
    if (cfg.note !== undefined && source.note === "auto") {
      options.note = cfg.note;
      source.note = from;
    }
  };
  if (repo) apply(repo, "repo");
  apply(wsAsRepo, "workspace");
  return { options, source };
}
