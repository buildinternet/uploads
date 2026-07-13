export type UploadsErrorCode =
  | "MISSING_TOKEN"
  | "NO_PUBLIC_URL"
  | "FILE_NOT_FOUND"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "INVALID_KEY"
  | "KEY_POLICY"
  | "STORAGE_QUOTA"
  | "UPLOAD_BUDGET"
  | "API_ERROR"
  | "NETWORK"
  | "USAGE";

export class UploadsError extends Error {
  readonly code: UploadsErrorCode;
  readonly status?: number;

  constructor(message: string, code: UploadsErrorCode, status?: number) {
    super(message);
    this.name = "UploadsError";
    this.code = code;
    this.status = status;
  }
}
