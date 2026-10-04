/**
 * Env-free scope helpers shared by the API (`apps/api/src/pr-scope.ts`), the
 * web app, and the CLI's generated copy. One type classifier, one scope
 * predicate, and one item-id hash, so every surface agrees on which objects
 * a live link (change feed) holds and how its items are addressed.
 */

export type FileTypeClass = "screenshot" | "video" | "other";

export const FILE_TYPE_CLASSES: readonly FileTypeClass[] = ["screenshot", "video", "other"];

/** Same sets as `apps/web/src/lib/workspace-screenshots.ts` `shotKindFromKey`. */
export const IMAGE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "webp", "gif", "avif"];
export const VIDEO_EXTENSIONS: readonly string[] = ["mp4", "webm", "mov"];

/**
 * Media class from the key's last extension. `file_metadata` has no content
 * type, so this is inferred, and keys without a known extension are "other".
 * The API's SQL type filter is built from the same two lists.
 */
export function fileTypeClassFromKey(key: string): FileTypeClass {
  const match = /\.([a-z0-9]{1,8})$/i.exec(key);
  const ext = match?.[1]?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.includes(ext)) return "screenshot";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  return "other";
}

/** `repo` is lowercased `owner/repo`; `number` > 0 or absent (repo-wide). */
export interface FeedScope {
  repo: string;
  number?: number;
}

/**
 * Whether an object's own metadata puts it in a live link's scope. Mirrors the
 * API's scope SQL exactly: `gh.repo` equals the lowercased scope repo (no
 * lowercasing of the stored value, because the SQL compares it verbatim and
 * every write stores it lowercased: apps/api file-metadata.ts
 * `canonicalMetaValue`),
 * `gh.number` equals the number as a decimal string when the scope has one,
 * and promoted branch shadows are excluded.
 */
export function isInFeedScope(metadata: Record<string, string>, scope: FeedScope): boolean {
  if (metadata["gh.repo"] !== scope.repo) return false;
  if (scope.number !== undefined && scope.number > 0) {
    if (metadata["gh.number"] !== String(scope.number)) return false;
  }
  return metadata["gh.status"] !== "promoted";
}

// Typed locally: this package compiles with `lib: ["ES2022"]` and no DOM or
// Workers types, while the API (Workers), web, and CLI (Node) all provide
// Web Crypto and TextEncoder at runtime.
interface WebCryptoGlobals {
  crypto: { subtle: { digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer> } };
  TextEncoder: new () => { encode(input: string): Uint8Array };
}

/** Stable live-link item id: first 32 hex chars of SHA-256(object key). */
export async function feedItemIdFor(objectKey: string): Promise<string> {
  const g = globalThis as unknown as WebCryptoGlobals;
  const digest = await g.crypto.subtle.digest("SHA-256", new g.TextEncoder().encode(objectKey));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex.slice(0, 32);
}
