/**
 * Registry of well-known application error codes. The wire schema keeps `code`
 * an open string (forward-compat), but producers reference this registry so
 * typos are compile errors.
 *
 * `ErrorCodeInput` (`ErrorCode | (string & {})`) preserves autocomplete while
 * still admitting codes outside the registry.
 *
 * Grouped by domain. New codes should follow `«domain»_«failure»` so the code
 * alone names both the feature and the failure.
 */
export const ERROR_CODES = [
  // Generic — subclass defaults
  "validation_error",
  "unauthorized",
  "forbidden",
  "insufficient_scope",
  "not_found",
  "method_not_allowed",
  "conflict",
  "payload_too_large",
  "unsupported_media_type",
  "rate_limited",
  "insufficient_storage",
  "service_unavailable",
  "internal_error",
  "malformed_error_response",

  // Files / keys
  "invalid_key",
  "invalid_body",
  "empty_body",
  "upload_too_large",
  "file_too_large",
  "key_prefix_not_allowed",
  "key_too_deep",
  "presign_unavailable",
  "file_url_unavailable",
  "auth_required",
  "invalid_visibility",

  // Budgets
  "storage_quota_exceeded",
  "upload_budget_exceeded",

  // Auth / enrollment / session
  "invalid_enrollment",
  "auth_lookup_failed",
  "auth_session_unavailable",
  "auth_unavailable",
  "invalid_session",
  "invalid_email",
  "invalid_role",
  "user_not_found",
  "org_not_found",
  "inviter_not_authorized",

  // Workspaces / tokens
  "invalid_workspace",
  "invalid_workspace_name",
  "reserved_workspace_name",
  "workspace_not_found",
  "workspace_name_taken",
  "workspace_cap_reached",
  "workspace_forbidden",
  "workspace_admin_required",
  "github_required",
  "invalid_scopes",
  "invalid_label",
  "invalid_expires",
  "invalid_request",
  "invalid_grant",
  "invalid_grants",
  "invalid_ttl",
  "multi_grant_unsupported",
  "hash_prefix_or_label_required",

  // Galleries
  "gallery_not_found",
  "gallery_item_not_found",
  "gallery_version_conflict",
  "gallery_limit_reached",
  "gallery_invalid_field",
  "gallery_invalid_cursor",
  "gallery_object_not_found",
  "gallery_object_not_public",
  "gallery_storage_unavailable",
  "gallery_reference_not_found",
  "gallery_invalid_reference",

  // File metadata
  "file_metadata_invalid_key",
  "file_metadata_invalid_value",
  "file_metadata_limit_exceeded",
  "file_metadata_reserved_key",
  "file_metadata_duplicate_filter",
  "file_metadata_too_many_filters",

  // Reports
  "reports_disabled",
  "bad_request",
  "attachment_too_large",
  "attachment_unavailable",
  "unsupported_attachment_type",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** A known code with autocomplete, or any other string (open wire contract). */
export type ErrorCodeInput = ErrorCode | (string & {});

export function isKnownErrorCode(code: string): code is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(code);
}
