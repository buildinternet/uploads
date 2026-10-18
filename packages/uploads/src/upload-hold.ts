/**
 * Held uploads, CLI side. The server holds a file the classifier flags for
 * a likely secret or sensitive personal data (`apps/api/src/upload-hold.ts`)
 * by writing `ai.hold=pending`. `uploads approve` releases it. The local-gh
 * comment path skips held files the same way the bot does.
 */

export const HOLD_META_KEY = "ai.hold";

export function isHeldUpload(meta: Record<string, string> | undefined): boolean {
  return meta?.[HOLD_META_KEY] === "pending";
}

/**
 * A short reason from the classifier rows, for `uploads approve` output.
 * `secret: api_key`, `personal data: financial`, or `flagged`.
 */
export function heldReason(meta: Record<string, string> | undefined): string {
  const secret = meta?.["ai.secret"];
  if (secret && secret !== "none") return `secret: ${secret}`;
  const pii = meta?.["ai.pii"];
  if (pii && pii !== "none") return `personal data: ${pii}`;
  return "flagged";
}
