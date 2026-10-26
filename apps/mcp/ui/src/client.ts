import {
  stagedPreviewUrl,
  type StagedMediaPage,
  type StagedScopePage,
  type StagedScope,
  type MediaContext,
  type AttachedMediaPage,
} from "../../src/staged-media-response";

export type Scope = StagedScope & { pr?: number };
export interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}
export type TrayEvent = { type: "input"; scope: Scope } | { type: "result"; result: ToolResult };
export interface TrayClient {
  connect(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  subscribe(listener: (event: TrayEvent) => void): () => void;
}

export function scopeFrom(value: unknown): Scope | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.repo === "string" &&
    candidate.repo.trim() &&
    typeof candidate.branch === "string" &&
    candidate.branch.trim()
    ? {
        repo: candidate.repo.trim(),
        branch: candidate.branch.trim(),
        ...(Number.isSafeInteger(candidate.pr) && Number(candidate.pr) > 0
          ? { pr: Number(candidate.pr) }
          : {}),
      }
    : null;
}
export function scopeKey(scope: StagedScope): string {
  return JSON.stringify([scope.repo.trim().toLowerCase(), scope.branch.trim().toLowerCase()]);
}
export function resultError(result: ToolResult): string | null {
  if (!result.isError) return null;
  return (
    result.content?.find((entry) => entry.type === "text")?.text || "Could not load staged media."
  );
}
function structured(result: ToolResult): Record<string, unknown> | undefined {
  return result.structuredContent && typeof result.structuredContent === "object"
    ? (result.structuredContent as Record<string, unknown>)
    : undefined;
}
export function needsScope(result: ToolResult): boolean {
  return structured(result)?.needsScope === true;
}
export function mediaPage(result: ToolResult): StagedMediaPage {
  const error = resultError(result);
  if (error) throw new Error(error);
  const data = structured(result);
  if (
    !scopeFrom(data) ||
    !Array.isArray(data?.items) ||
    data.items.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        typeof item.id !== "string" ||
        typeof item.key !== "string" ||
        typeof item.filename !== "string" ||
        !(item.previewUrl === null || typeof item.previewUrl === "string") ||
        !["image", "video", "other"].includes(item.mediaType) ||
        !["available", "withheld", "missing", "unsupported"].includes(item.status) ||
        ![item.state, item.path, item.stagedAt].every(
          (value) => value === null || typeof value === "string",
        ),
    ) ||
    !(data.cursor === null || typeof data.cursor === "string")
  ) {
    throw new Error("The server returned an invalid staged-media response.");
  }
  return data as unknown as StagedMediaPage;
}
export function scopePage(result: ToolResult): StagedScopePage {
  const error = resultError(result);
  if (error) throw new Error(error);
  const data = structured(result);
  if (
    !Array.isArray(data?.scopes) ||
    data.scopes.some((scope) => !scopeFrom(scope)) ||
    !(data.cursor === null || typeof data.cursor === "string")
  ) {
    throw new Error("The server returned an invalid branch list.");
  }
  return data as unknown as StagedScopePage;
}
export function mediaContext(result: ToolResult): MediaContext {
  const error = resultError(result);
  if (error) throw new Error(error);
  const data = structured(result);
  if (
    !scopeFrom(data) ||
    !(data?.pr === null || (Number.isSafeInteger(data?.pr) && Number(data?.pr) > 0)) ||
    !["explicit", "resolved", "unavailable"].includes(String(data?.prResolution))
  )
    throw new Error("The server returned an invalid pull-request context.");
  return data as unknown as MediaContext;
}
export function attachedPage(result: ToolResult): AttachedMediaPage {
  const page = mediaPage(result);
  const data = structured(result);
  if (!Number.isSafeInteger(data?.pr) || Number(data?.pr) < 1)
    throw new Error("The server returned an invalid attached-files response.");
  return { ...page, pr: Number(data?.pr) };
}
export function safePreviewUrl(value: unknown): string | null {
  return typeof value === "string" ? stagedPreviewUrl(value) : null;
}
