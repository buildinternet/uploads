/**
 * Pure extraction of github.com/user-attachments references from PR/issue
 * markdown. The asset id (path after /user-attachments/) is the stable
 * identity the ingest ledger keys on — GitHub keeps it constant across
 * renders/edits. No I/O; safe to call from extractWebhookEvent.
 */
const ATTACHMENT_RE =
  /https:\/\/github\.com\/user-attachments\/(assets\/[0-9a-fA-F-]{8,}|files\/\d+\/[^\s)"'<>\]]+)/g;

export interface ExtractedAttachment {
  id: string;
  url: string;
}

export function extractUserAttachments(text: string): ExtractedAttachment[] {
  const seen = new Set<string>();
  const out: ExtractedAttachment[] = [];
  for (const m of text.matchAll(ATTACHMENT_RE)) {
    const id = m[1].replace(/[.,;:]+$/, ""); // trailing prose punctuation
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, url: `https://github.com/user-attachments/${id}` });
  }
  return out;
}

export function hasUserAttachmentUrl(text: string): boolean {
  return text.includes("github.com/user-attachments/");
}

export function attachmentKeyBasename(id: string): string {
  const flat = id.replace(/^(assets|files)\//, "").replace(/\//g, "-");
  return flat
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/-+\./g, ".") // "final-.png" -> "final.png"
    .replace(/^[-.]+|-+$/g, "");
}
