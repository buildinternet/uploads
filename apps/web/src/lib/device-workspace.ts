/**
 * Which panel the /device approval page shows (issue #362). Kept out of
 * device.astro so the decision is unit-testable on its own — the pattern
 * session-device.ts already sets.
 *
 * `requested`/`create` come from GET /api/auth/device/workspace, which reads
 * them off the device-code row's scope: what the terminal asked for, not
 * anything the browser's URL claims.
 */

export interface DeviceWorkspaceOption {
  slug: string;
  name: string;
}

export type DeviceWorkspaceState =
  /** The terminal named a workspace this account can't reach — approval must not proceed as-is. */
  | { kind: "denied"; requested: string; options: DeviceWorkspaceOption[] }
  /** `uploads login --workspace X --create`: the CLI provisions after approval, so never block. */
  | { kind: "provision"; requested: string }
  /** Pick from the account's workspaces (or create a new one). */
  | { kind: "choose"; options: DeviceWorkspaceOption[]; selected: string }
  /** No workspaces and nothing requested — first run. */
  | { kind: "first_run" };

export function resolveDeviceWorkspaceState(input: {
  requested: string | null;
  create: boolean;
  workspaces: DeviceWorkspaceOption[];
}): DeviceWorkspaceState {
  const { requested, create, workspaces } = input;
  if (requested && create) return { kind: "provision", requested };
  const member = requested ? workspaces.find((w) => w.slug === requested) : undefined;
  if (requested && !member) return { kind: "denied", requested, options: workspaces };
  if (workspaces.length === 0) return { kind: "first_run" };
  // `workspaces` arrives oldest-membership-first from the auth worker, so
  // [0] is the same default the AS itself would resolve.
  return { kind: "choose", options: workspaces, selected: member?.slug ?? workspaces[0]!.slug };
}
