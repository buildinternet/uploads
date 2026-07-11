import { type ErrorCodeInput } from "./codes";
import { statusForType, type ErrorType } from "./types";
import { type ErrorEnvelope } from "./wire";

export const GENERIC_MESSAGE = "Something went wrong.";

export interface AppErrorInit {
  code: ErrorCodeInput;
  message: string;
  type: ErrorType;
  /**
   * Defaults to the HTTP status for `type`. Overrides the derived status for
   * the in-process throw/response only. NOT carried on the wire — a client
   * decoding via `fromWire` always recomputes status from `type`.
   */
  status?: number;
  details?: unknown;
  /** When false, `toWire` hides the real message. Defaults to true. */
  expose?: boolean;
  cause?: unknown;
}

/** Base class for all typed application errors. */
export class AppError extends Error {
  readonly code: ErrorCodeInput;
  readonly type: ErrorType;
  readonly status: number;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(init: AppErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = new.target.name;
    this.code = init.code;
    this.type = init.type;
    this.status = init.status ?? statusForType(init.type);
    this.details = init.details;
    this.expose = init.expose ?? true;
  }

  toWire(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        type: this.type,
        message: this.expose ? this.message : GENERIC_MESSAGE,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }

  /** Coerce any thrown value into an AppError (for the API onError boundary). */
  static from(err: unknown): AppError {
    if (err instanceof AppError) return err;
    return new AppError({
      code: "internal_error",
      type: "internal",
      message: err instanceof Error ? err.message : String(err),
      expose: false,
      cause: err,
    });
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
