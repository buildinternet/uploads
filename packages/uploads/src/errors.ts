export type UploadsErrorCode =
  | "MISSING_TOKEN"
  | "NO_PUBLIC_URL"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "INVALID_KEY"
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
