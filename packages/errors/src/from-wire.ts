import { AppError } from "./base";
import { isErrorEnvelope } from "./wire";

/**
 * Decode an API error body into an AppError. Reconstructs a generic AppError
 * carrying the wire `code`/`type` (not a specific subclass), so a server `code`
 * the client does not recognize still decodes cleanly. Never throws: a malformed
 * body becomes a non-exposed internal error.
 */
export function fromWire(body: unknown): AppError {
  if (!isErrorEnvelope(body)) {
    return new AppError({
      code: "malformed_error_response",
      type: "internal",
      message: "The server returned an unrecognized error response.",
      expose: false,
    });
  }
  const { code, type, message, details } = body.error;
  return new AppError({ code, type, message, details });
}
