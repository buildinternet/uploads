export type UploadsErrorCode =
  | "MISSING_TOKEN"
  | "NO_PUBLIC_URL"
  | "FILE_NOT_FOUND"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "INSUFFICIENT_SCOPE"
  | "INVALID_KEY"
  | "KEY_POLICY"
  | "STORAGE_QUOTA"
  | "UPLOAD_BUDGET"
  | "GITHUB_REQUIRED"
  | "KEY_EXISTS"
  | "API_ERROR"
  | "NETWORK"
  | "USAGE"
  | "BROWSER_NOT_FOUND"
  | "RENDER_FAILED"
  | "RATE_LIMITED";

export class UploadsError extends Error {
  readonly code: UploadsErrorCode;
  readonly status?: number;
  /**
   * The existing object's public URL, set only for `KEY_EXISTS` (strict
   * overwrite refusal, issue #174) — lets a catch site point the caller at
   * what's already there without a follow-up lookup.
   */
  readonly existingUrl?: string;

  constructor(
    message: string,
    code: UploadsErrorCode,
    status?: number,
    opts?: { existingUrl?: string },
  ) {
    super(message);
    this.name = "UploadsError";
    this.code = code;
    this.status = status;
    this.existingUrl = opts?.existingUrl;
  }
}
