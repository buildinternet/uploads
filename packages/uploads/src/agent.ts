import type { Files } from "files-sdk";
import { createFileTools, type FileToolsOptions } from "files-sdk/ai-sdk";

export type { FileReadToolName, FileToolName, FileWriteToolName } from "files-sdk/ai-sdk";

/**
 * Worker-side agent tools (Mode A). Pass `Files` from `createStorage()` —
 * reuses files-sdk tool schemas; do not duplicate MCP tool definitions here.
 */
export function createUploadsWorkerFileTools(
  files: Files,
  opts: Omit<FileToolsOptions, "files"> = {},
) {
  const { overrides, requireApproval, ...rest } = opts;
  return createFileTools({
    files,
    requireApproval: requireApproval ?? {
      deleteFile: true,
      uploadFile: false,
      copyFile: true,
      signUploadUrl: true,
    },
    overrides: {
      uploadFile: {
        description:
          "Upload a file for public hosting (e.g. GitHub embeds). Prefer keys under screenshots/.",
      },
      ...overrides,
    },
    ...rest,
  });
}