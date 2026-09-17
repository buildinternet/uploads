/**
 * Pure extraction of ingestible attachment URLs from PR/issue markdown.
 *
 * GitHub-native `user-attachments` ids (path after /user-attachments/) and
 * public Cursor rewrite URLs (`cursor.com/artifacts/c/art-<uuid>`) are the
 * stable identities the ingest ledger keys on. Viewer (`/artifacts/v/`) and
 * login-walled agent-page links are detected separately so ingest can skip
 * them with a hint — they are never fetched as media. No I/O; safe to call
 * from extractWebhookEvent.
 */
const ATTACHMENT_RE =
  /https:\/\/github\.com\/user-attachments\/(assets\/[0-9a-fA-F-]{8,}|files\/\d+\/[^\s)"'<>\]]+)/g;

/** Standard UUID after `art-`, as Cursor emits on `/artifacts/{c|v}/art-<uuid>`. */
const CURSOR_ART_ID = "art-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}";
const CURSOR_C_RE = new RegExp(`https://cursor\\.com/artifacts/c/(${CURSOR_ART_ID})`, "g");
const CURSOR_V_RE = new RegExp(`https://cursor\\.com/artifacts/v/(${CURSOR_ART_ID})`, "g");
const CURSOR_AGENT_RE = /https:\/\/cursor\.com\/agents\/[^\s/"'<>]+\/artifacts(?:\?[^\s)"'<>]*)?/g;
const CURSOR_MD_IMG_RE = new RegExp(
  `!\\[([^\\]]*)\\]\\((https://cursor\\.com/artifacts/c/${CURSOR_ART_ID})\\)`,
  "g",
);
const HTML_IMG_RE = /<img\b[^>]*>/gi;

export const CURSOR_VIEWER_SKIP_REASON =
  "cursor_viewer — HTML viewer, not public bytes; enable Allow posting artifacts to GitHub";
export const CURSOR_AGENT_PAGE_SKIP_REASON =
  "cursor_agent_page — login-walled agent page; enable Allow posting artifacts to GitHub";

export type IngestOrigin = "github" | "cursor";

export interface ExtractedAttachment {
  id: string;
  url: string;
  origin?: IngestOrigin;
  /** Markdown/HTML alt text when present — Cursor object naming prefers this. */
  alt?: string;
}

export type UnimportableCursorKind = "viewer" | "agent_page";

export interface UnimportableCursorRef {
  url: string;
  kind: UnimportableCursorKind;
  /** Set for `/artifacts/v/art-*` so a matching `/c/` import can silence the skip. */
  artId?: string;
}

export function extractUserAttachments(text: string): ExtractedAttachment[] {
  const seen = new Set<string>();
  const out: ExtractedAttachment[] = [];
  for (const m of text.matchAll(ATTACHMENT_RE)) {
    const id = m[1].replace(/[.,;:]+$/, ""); // trailing prose punctuation
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      url: `https://github.com/user-attachments/${id}`,
      origin: "github",
    });
  }
  return out;
}

export function extractCursorContentAttachments(text: string): ExtractedAttachment[] {
  const alts = cursorAltByArtId(text);
  const seen = new Set<string>();
  const out: ExtractedAttachment[] = [];
  for (const m of text.matchAll(CURSOR_C_RE)) {
    const artId = m[1];
    const id = cursorAssetId(artId);
    if (seen.has(id)) continue;
    seen.add(id);
    const alt = alts.get(artId);
    out.push({
      id,
      url: `https://cursor.com/artifacts/c/${artId}`,
      origin: "cursor",
      ...(alt ? { alt } : {}),
    });
  }
  return out;
}

/** GitHub-native attachments plus public Cursor `/artifacts/c/art-*` rewrite URLs. */
export function extractIngestAttachments(text: string): ExtractedAttachment[] {
  return [...extractUserAttachments(text), ...extractCursorContentAttachments(text)];
}

export function extractUnimportableCursorRefs(text: string): UnimportableCursorRef[] {
  const seen = new Set<string>();
  const out: UnimportableCursorRef[] = [];
  for (const m of text.matchAll(CURSOR_V_RE)) {
    const url = `https://cursor.com/artifacts/v/${m[1]}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, kind: "viewer", artId: m[1] });
  }
  for (const m of text.matchAll(CURSOR_AGENT_RE)) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, kind: "agent_page" });
  }
  return out;
}

export function hasUserAttachmentUrl(text: string): boolean {
  return text.includes("github.com/user-attachments/");
}

export function hasCursorContentUrl(text: string): boolean {
  return text.includes("cursor.com/artifacts/c/art-");
}

export function isCursorAssetId(id: string): boolean {
  return id.startsWith("cursor/");
}

export function cursorAssetId(artId: string): string {
  return `cursor/${artId}`;
}

export function attachmentKeyBasename(id: string): string {
  const flat = id.replace(/^(assets|files|cursor)\//, "").replace(/\//g, "-");
  return flat
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/-+\./g, ".") // "final-.png" -> "final.png"
    .replace(/^[-.]+|-+$/g, "");
}

function cursorAltByArtId(text: string): Map<string, string> {
  const alts = new Map<string, string>();
  for (const m of text.matchAll(CURSOR_MD_IMG_RE)) {
    const artId = artIdFromCursorCUrl(m[2]);
    const alt = m[1].trim();
    if (artId && alt && !alts.has(artId)) alts.set(artId, alt);
  }
  for (const m of text.matchAll(HTML_IMG_RE)) {
    const tag = m[0];
    const src = htmlAttr(tag, "src");
    const artId = src ? artIdFromCursorCUrl(src) : undefined;
    if (!artId || alts.has(artId)) continue;
    const alt = htmlAttr(tag, "alt")?.trim();
    if (alt) alts.set(artId, alt);
  }
  return alts;
}

function artIdFromCursorCUrl(url: string): string | undefined {
  const m = new RegExp(`^https://cursor\\.com/artifacts/c/(${CURSOR_ART_ID})$`).exec(url);
  return m?.[1];
}

function htmlAttr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  return m?.[1] ?? m?.[2] ?? m?.[3];
}
