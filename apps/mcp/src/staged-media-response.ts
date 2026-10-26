/** Env-free wire contract shared by the hosted tool and its MCP App. */
import type { FeedItemDto } from "@uploads/api/scope-wire";

export interface StagedScope {
  repo: string;
  branch: string;
}
export interface StagedScopePage {
  scopes: StagedScope[];
  cursor: string | null;
}
export interface StagedMediaItem {
  id: string;
  key: string;
  filename: string;
  previewUrl: string | null;
  mediaType: "image" | "video" | "other";
  status: "available" | "withheld" | "missing" | "unsupported";
  state: string | null;
  path: string | null;
  stagedAt: string | null;
}
export interface StagedMediaPage extends StagedScope {
  items: StagedMediaItem[];
  cursor: string | null;
}
export interface MediaContext extends StagedScope {
  pr: number | null;
  prResolution: "explicit" | "resolved" | "unavailable";
}
export interface AttachedMediaPage extends StagedMediaPage {
  pr: number;
}

/** Must stay aligned with the App resource's external asset CSP. */
export function stagedPreviewUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["embed.uploads.sh", "storage.uploads.sh"].includes(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function stagedMediaResponse(
  scope: StagedScope,
  items: FeedItemDto[],
  metadata: ReadonlyMap<string, Record<string, string>>,
  cursor: string | null,
): StagedMediaPage {
  return {
    ...scope,
    cursor,
    items: items.map((item) => {
      const mediaType = item.contentType?.startsWith("image/")
        ? "image"
        : item.contentType?.startsWith("video/")
          ? "video"
          : "other";
      const previewUrl =
        item.status === "available" && mediaType !== "other"
          ? stagedPreviewUrl(item.embedUrl ?? item.url)
          : null;
      return {
        id: item.id,
        key: item.objectKey,
        filename: item.filename,
        previewUrl,
        mediaType,
        status: item.status === "available" && !previewUrl ? "unsupported" : item.status,
        state: item.state,
        path: item.path,
        stagedAt:
          item.status === "withheld"
            ? null
            : (metadata.get(item.objectKey)?.["gh.staged-at"] ?? null),
      };
    }),
  };
}

const nullableString = { type: ["string", "null"] };
const scopeProperties = { repo: { type: "string" }, branch: { type: "string" } };
export const mediaContextProperties = {
  pr: { type: ["integer", "null"], minimum: 1 },
  prResolution: { type: "string", enum: ["explicit", "resolved", "unavailable"] },
};
export const stagedMediaOutputSchemas: Record<string, Record<string, unknown>> = {
  list_staged_media: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...scopeProperties,
      cursor: nullableString,
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            key: { type: "string" },
            filename: { type: "string" },
            previewUrl: nullableString,
            mediaType: { type: "string", enum: ["image", "video", "other"] },
            status: { type: "string", enum: ["available", "withheld", "missing", "unsupported"] },
            state: nullableString,
            path: nullableString,
            stagedAt: nullableString,
          },
          required: [
            "id",
            "key",
            "filename",
            "previewUrl",
            "mediaType",
            "status",
            "state",
            "path",
            "stagedAt",
          ],
        },
      },
    },
    required: ["repo", "branch", "items", "cursor"],
  },
  list_staged_scopes: {
    type: "object",
    additionalProperties: false,
    properties: {
      cursor: nullableString,
      scopes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: scopeProperties,
          required: ["repo", "branch"],
        },
      },
    },
    required: ["scopes", "cursor"],
  },
  resolve_media_context: {
    type: "object",
    additionalProperties: false,
    properties: { ...scopeProperties, ...mediaContextProperties },
    required: ["repo", "branch", "pr", "prResolution"],
  },
};

stagedMediaOutputSchemas.list_attached_media = {
  ...stagedMediaOutputSchemas.list_staged_media,
  properties: {
    ...(stagedMediaOutputSchemas.list_staged_media!.properties as Record<string, unknown>),
    pr: { type: "integer", minimum: 1 },
  },
  required: ["repo", "branch", "pr", "items", "cursor"],
};
