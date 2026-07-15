import { AppError } from "./base";
import { type ErrorCodeInput } from "./codes";

interface SubclassOpts {
  code?: ErrorCodeInput;
  details?: unknown;
  cause?: unknown;
}

export class ValidationError extends AppError {
  constructor(message = "Invalid request.", opts: SubclassOpts = {}) {
    super({
      type: "validation",
      code: opts.code ?? "validation_error",
      message,
      details: opts.details,
      cause: opts.cause,
    });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required.", opts: SubclassOpts = {}) {
    super({
      type: "unauthorized",
      code: opts.code ?? "unauthorized",
      message,
      details: opts.details,
      cause: opts.cause,
    });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden.", opts: SubclassOpts = {}) {
    super({
      type: "forbidden",
      code: opts.code ?? "forbidden",
      message,
      details: opts.details,
      cause: opts.cause,
    });
  }
}

/** Missing OAuth/API scope — fixed code + `{ required_scope }` details. */
export class InsufficientScopeError extends AppError {
  constructor(requiredScope: string, message = "Insufficient scope.") {
    super({
      type: "insufficient_scope",
      code: "insufficient_scope",
      message,
      details: { required_scope: requiredScope },
    });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found.", opts: SubclassOpts = {}) {
    super({
      type: "not_found",
      code: opts.code ?? "not_found",
      message,
      details: opts.details,
      cause: opts.cause,
    });
  }
}

export class MethodNotAllowedError extends AppError {
  constructor(message = "Method not allowed.", opts: SubclassOpts = {}) {
    super({
      type: "method_not_allowed",
      code: opts.code ?? "method_not_allowed",
      message,
      details: opts.details,
      cause: opts.cause,
    });
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict.", opts: SubclassOpts = {}) {
    super({
      type: "conflict",
      code: opts.code ?? "conflict",
      message,
      details: opts.details,
      cause: opts.cause,
    });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = "Payload too large.", opts: SubclassOpts = {}) {
    super({
      type: "payload_too_large",
      code: opts.code ?? "payload_too_large",
      message,
      details: opts.details,
      cause: opts.cause,
    });
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = "Unsupported media type.", opts: SubclassOpts = {}) {
    super({
      type: "unsupported_media_type",
      code: opts.code ?? "unsupported_media_type",
      message,
      details: opts.details,
      cause: opts.cause,
    });
  }
}

export class RateLimitedError extends AppError {
  readonly retryAfterSeconds?: number;
  constructor(
    message = "Too many requests.",
    opts: SubclassOpts & { retryAfterSeconds?: number } = {},
  ) {
    super({
      type: "rate_limited",
      code: opts.code ?? "rate_limited",
      message,
      details:
        opts.retryAfterSeconds !== undefined
          ? { ...(opts.details as object | undefined), retry_after: opts.retryAfterSeconds }
          : opts.details,
      cause: opts.cause,
    });
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

/** Storage budget exceeded (HTTP 507). */
export class InsufficientStorageError extends AppError {
  constructor(message = "Insufficient storage.", opts: SubclassOpts = {}) {
    super({
      type: "insufficient_storage",
      code: opts.code ?? "insufficient_storage",
      message,
      details: opts.details,
      cause: opts.cause,
    });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service unavailable.", opts: SubclassOpts = {}) {
    super({
      type: "unavailable",
      code: opts.code ?? "service_unavailable",
      message,
      details: opts.details,
      cause: opts.cause,
    });
  }
}

export class InternalError extends AppError {
  constructor(message = "Internal error.", opts: SubclassOpts = {}) {
    super({
      type: "internal",
      code: opts.code ?? "internal_error",
      message,
      details: opts.details,
      cause: opts.cause,
      expose: false,
    });
  }
}
