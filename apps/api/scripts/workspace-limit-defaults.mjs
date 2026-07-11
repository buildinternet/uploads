/**
 * Default limit template for `add-workspace.mjs`. Values live in
 * workspace-limit-defaults.json (shared/agent profile — docs/ops.md).
 *
 * Opt out at create time with `--no-default-limits`.
 */
import template from "./workspace-limit-defaults.json" with { type: "json" };

export const SHARED_AGENT_LIMIT_TEMPLATE = Object.freeze({
  ...template,
  allowedKeyPrefixes: Object.freeze([...template.allowedKeyPrefixes]),
});

/** Shallow copy suitable for spreading onto a new WorkspaceRecord. */
export function sharedAgentLimitFields() {
  return {
    maxStorageBytes: template.maxStorageBytes,
    maxUploadsPerPeriod: template.maxUploadsPerPeriod,
    maxUploadBytes: template.maxUploadBytes,
    maxVideoUploadBytes: template.maxVideoUploadBytes,
    allowedKeyPrefixes: [...template.allowedKeyPrefixes],
    maxKeyDepth: template.maxKeyDepth,
  };
}
