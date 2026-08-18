/**
 * POST /v1/workspaces/:workspace/github/attach (issue #702). Workspace-authed
 * (canonical dual-auth surface, mounted from `routes/workspace-github.ts`).
 * Attaches an ALREADY-UPLOADED object — identified by key or by an
 * uploads.sh URL in any of the three spellings (storage host, embed host,
 * `/f/` page) — to a PR or issue via an in-bucket server-side copy, additive
 * metadata merge, and the normal managed-comment sync. Generalizes
 * `routes/github-promote.ts`'s branch-staged sweep to an arbitrary explicit
 * source; see `github-attach.ts`/`github-attach-service.ts` for the copy and
 * comment-sync logic respectively.
 *
 * Copy by default; `move: true` deletes the source only after a successful
 * copy. Idempotent — re-attaching the same source to the same target
 * overwrites the destination key in place.
 */
import { ValidationError } from "@uploads/errors";
import type { Context } from "hono";
import { postAttachExisting } from "../github-attach-service";
import type { WorkspaceVars } from "../workspace";
import { jsonBody } from "./json-body";

// Same repo grammar + dot-only-segment guard as github-promote.ts/github-comment.ts.
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DOTS_ONLY_RE = /^\.+$/;
const MAX_SOURCE_LEN = 2048;
const MAX_FILENAME_LEN = 255;

interface AttachBody {
  source: string;
  repo: string;
  kind: "pull" | "issues";
  num: number;
  move: boolean;
  filename?: string;
}

function parseBody(body: Record<string, unknown>): AttachBody {
  const source = typeof body.source === "string" ? body.source : "";
  const repo = typeof body.repo === "string" ? body.repo : "";
  const pr = typeof body.pr === "number" ? body.pr : undefined;
  const issue = typeof body.issue === "number" ? body.issue : undefined;
  const move = body.move === true;
  const filename = typeof body.filename === "string" ? body.filename : undefined;

  if (source.length === 0 || source.length > MAX_SOURCE_LEN) {
    throw new ValidationError("source must be a non-empty string.", { code: "invalid_source" });
  }
  if (!REPO_RE.test(repo) || repo.split("/").some((seg) => DOTS_ONLY_RE.test(seg))) {
    throw new ValidationError("repo must be owner/name.", { code: "invalid_repo" });
  }
  if (pr === undefined && issue === undefined) {
    throw new ValidationError("exactly one of pr or issue is required.", {
      code: "invalid_target",
    });
  }
  if (pr !== undefined && issue !== undefined) {
    throw new ValidationError("pr and issue are mutually exclusive.", { code: "invalid_target" });
  }
  const num = pr ?? issue;
  if (num === undefined || !Number.isSafeInteger(num) || num < 1) {
    throw new ValidationError("pr/issue must be a positive integer.", { code: "invalid_target" });
  }
  if (filename !== undefined && (filename.length === 0 || filename.length > MAX_FILENAME_LEN)) {
    throw new ValidationError("filename must be a non-empty string.", { code: "invalid_filename" });
  }
  if (body.move !== undefined && typeof body.move !== "boolean") {
    throw new ValidationError("move must be a boolean.", { code: "invalid_move" });
  }

  return { source, repo, kind: pr !== undefined ? "pull" : "issues", num, move, filename };
}

export async function githubAttachHandler(c: Context<WorkspaceVars>) {
  const parsed = parseBody(await jsonBody(c));
  const result = await postAttachExisting(
    c.env,
    c.get("workspace"),
    c.get("workspaceName"),
    c.get("mintingUserId"),
    {
      source: parsed.source,
      target: { repo: parsed.repo, kind: parsed.kind, num: parsed.num },
      move: parsed.move,
      filename: parsed.filename,
    },
  );
  return c.json(result);
}
