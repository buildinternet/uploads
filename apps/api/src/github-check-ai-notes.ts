/**
 * AI notes (`.uploads.yml` `check.ai`): advisory findings the "Check for
 * visuals" run and the managed comment show under the checklist. They read
 * labels the classifier already stored on each file (`ai.ready`,
 * `ai.phash`), so a sync never calls a model, and they never change the
 * check's conclusion. A note with nothing to read, including a file the
 * classifier failed on, is `skipped` and stays out of the check and the
 * comment. It is never `ok` or `warning`. When every note is skipped, that
 * section is left out. Any error drops the notes and leaves the comment and
 * check as before. The `uploads:no-ai` label on the PR turns them off.
 */
import type { CheckAiNote } from "@uploads/comment-config";
import type { AiNote, GhTarget } from "./github-comment-render";
import { getMetadataForKeys, PHASH_META_KEY } from "./file-metadata";
import { dbFor } from "./db-session";
import { skipLabelOnPr } from "./github-check-requirements";

/** The PR label that hides the AI notes. */
export const AI_NOTES_SKIP_LABEL = "uploads:no-ai";

const AI_NOTE_META_KEYS = ["state", "ai.ready", PHASH_META_KEY];

/** `ai.ready` answers the ready-screen note warns about, with what each says. */
const NOT_READY: Record<string, string> = {
  loading: "looks like it is still loading",
  blank: "looks blank",
  error: "shows an error instead of the screen",
};

export interface AiNoteFile {
  name: string;
  meta: Record<string, string> | undefined;
}

function code(name: string): string {
  return "`" + name.replace(/`/g, "'") + "`";
}

const NOT_CLASSIFIED = "No AI labels for these files yet.";

/**
 * Warns on a file marked `after` that looks unfinished. A broken screen is a
 * fine before, so before files and unmarked files are never judged. Pure.
 */
export function readyScreenNote(files: readonly AiNoteFile[]): AiNote {
  const after = files.filter((f) => f.meta?.state === "after");
  if (after.length === 0) {
    return {
      label: "After screens not checked",
      outcome: "skipped",
      details: ["No files are marked as after."],
    };
  }
  const judged = after.filter((f) => f.meta?.["ai.ready"]);
  if (judged.length === 0) {
    return { label: "After screens not checked", outcome: "skipped", details: [NOT_CLASSIFIED] };
  }
  const flagged = judged.filter((f) => NOT_READY[f.meta?.["ai.ready"] ?? ""]);
  if (flagged.length > 0) {
    return {
      label: "An after screen may not show the change",
      outcome: "warning",
      details: flagged.map((f) => `${code(f.name)} ${NOT_READY[f.meta?.["ai.ready"] ?? ""]}`),
    };
  }
  return { label: "After screens look ready", outcome: "ok", details: [] };
}

/** Same picture, allowing a few bits of compression noise. Reuse lookup stays exact. */
const IDENTICAL_PHASH_DISTANCE = 4;

function phashBits(hash: string | undefined): bigint | undefined {
  if (!hash || !/^[0-9a-f]{16}$/.test(hash)) return undefined;
  return BigInt(`0x${hash}`);
}

function hammingDistance(a: bigint, b: bigint): number {
  let n = 0;
  for (let x = a ^ b; x; x &= x - 1n) n++;
  return n;
}

/**
 * Warns when a before and an after are within IDENTICAL_PHASH_DISTANCE bits
 * of the same perceptual hash. A missing or malformed hash is not a match;
 * with nothing comparable the note is skipped. Pure.
 */
export function identicalBeforeAfterNote(files: readonly AiNoteFile[]): AiNote {
  const before = files.filter((f) => f.meta?.state === "before");
  const after = files.filter((f) => f.meta?.state === "after");
  if (before.length === 0 || after.length === 0) {
    return {
      label: "Before and after not compared",
      outcome: "skipped",
      details: ["Needs a file marked as before and one marked as after."],
    };
  }
  const beforeBits = before.flatMap((f) => {
    const bits = phashBits(f.meta?.[PHASH_META_KEY]);
    return bits === undefined ? [] : [{ name: f.name, bits }];
  });
  const afterBits = after.flatMap((f) => {
    const bits = phashBits(f.meta?.[PHASH_META_KEY]);
    return bits === undefined ? [] : [{ name: f.name, bits }];
  });
  if (beforeBits.length === 0 || afterBits.length === 0) {
    return {
      label: "Before and after not compared",
      outcome: "skipped",
      details: [NOT_CLASSIFIED],
    };
  }
  const same = beforeBits.flatMap((b) =>
    afterBits.flatMap((a) =>
      hammingDistance(b.bits, a.bits) <= IDENTICAL_PHASH_DISTANCE
        ? [`${code(b.name)} and ${code(a.name)} look the same`]
        : [],
    ),
  );
  if (same.length > 0) {
    return { label: "Before and after look the same", outcome: "warning", details: same };
  }
  return { label: "Before and after differ", outcome: "ok", details: [] };
}

const NOTES: Record<CheckAiNote, (files: readonly AiNoteFile[]) => AiNote> = {
  "ready-screen": readyScreenNote,
  "identical-before-after": identicalBeforeAfterNote,
};

/** The repo's notes for `files`, in `check.ai` order. Pure. */
export function aiNotesFor(
  enabled: readonly CheckAiNote[],
  files: readonly AiNoteFile[],
): AiNote[] {
  return enabled.map((id) => NOTES[id](files));
}

/**
 * The AI notes for a PR's shown attachment `keys`. Empty when the repo has
 * none on, the target isn't a PR, nothing is attached, or the PR carries
 * the `uploads:no-ai` label. Held files are not in `keys`, so a note never
 * names one.
 */
export async function evaluateAiNotes(
  env: Env,
  workspaceName: string,
  target: GhTarget,
  enabled: readonly CheckAiNote[],
  keys: readonly string[],
): Promise<AiNote[]> {
  if (target.kind !== "pull" || enabled.length === 0 || keys.length === 0) return [];
  try {
    const [skipped, metaByKey] = await Promise.all([
      skipLabelOnPr(env, target, [AI_NOTES_SKIP_LABEL]),
      getMetadataForKeys(dbFor(env), workspaceName, [...keys], { metaKeys: AI_NOTE_META_KEYS }),
    ]);
    if (skipped) return [];
    const notes = aiNotesFor(
      enabled,
      keys.map((key) => ({ name: key.slice(key.lastIndexOf("/") + 1), meta: metaByKey.get(key) })),
    );
    console.log({
      event: "ai_notes_evaluated",
      workspace: workspaceName,
      repo: target.repo,
      pr: target.num,
      notes: Object.fromEntries(enabled.map((id, i) => [id, notes[i]?.outcome])),
    });
    return notes;
  } catch (err) {
    // Fail open: a failed read drops the notes, never the comment or the check.
    console.error({ event: "ai_notes_failed", workspace: workspaceName, err });
    return [];
  }
}
