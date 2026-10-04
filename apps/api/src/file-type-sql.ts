/**
 * The Files `type` filter as SQL (spec "Files views"): a key-extension
 * class, matched with `lower(substr(col, -N))` because D1 caps LIKE/GLOB
 * patterns at 50 bytes. Suffix sets come from `@uploads/comment-render/scope`,
 * so the SQL and `fileTypeClassFromKey` agree (test/file-type-sql.test.ts
 * pins the parity). One implementation for the scope query (pr-scope.ts),
 * the Files endpoints (routes/workspace-scope.ts), and `GET /files/by-path`.
 */
import { ValidationError } from "@uploads/errors";
import {
  FILE_TYPE_CLASSES,
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  type FileTypeClass,
} from "@uploads/comment-render/scope";

const COLUMN_RE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i;

/** `(lower(substr(col, -4)) IN ('.png', …) OR lower(substr(col, -5)) IN (…))`. */
function suffixMatchSql(column: string, extensions: readonly string[]): string {
  const byLength = new Map<number, string[]>();
  for (const ext of extensions) {
    const suffix = `.${ext}`;
    byLength.set(suffix.length, [...(byLength.get(suffix.length) ?? []), `'${suffix}'`]);
  }
  const terms = [...byLength.entries()]
    .sort(([a], [b]) => a - b)
    .map(
      ([length, suffixes]) => `lower(substr(${column}, -${length})) IN (${suffixes.join(", ")})`,
    );
  return `(${terms.join(" OR ")})`;
}

/** SQL predicate on `column` (a trusted identifier such as `r.object_key`, never user input). */
export function fileTypeSql(column: string, type: FileTypeClass): string {
  if (!COLUMN_RE.test(column)) throw new Error(`fileTypeSql: bad column ${column}`);
  const image = suffixMatchSql(column, IMAGE_EXTENSIONS);
  const video = suffixMatchSql(column, VIDEO_EXTENSIONS);
  if (type === "screenshot") return image;
  if (type === "video") return video;
  return `(NOT ${image} AND NOT ${video})`;
}

/** `?type=`: undefined when absent or empty; 400 `invalid_type` for anything else. */
export function parseFileTypeQuery(raw: string | undefined): FileTypeClass | undefined {
  if (raw === undefined || raw === "") return undefined;
  const match = FILE_TYPE_CLASSES.find((type) => type === raw);
  if (match) return match;
  throw new ValidationError("type must be screenshot, video, or other.", {
    code: "invalid_type",
  });
}
