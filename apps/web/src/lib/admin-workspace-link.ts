/**
 * The admin workspaces page opens one workspace's drawer from `?workspace=`.
 * The storage operator FYI links here (`packages/email` builds the same query).
 */
export function workspaceFromAdminSearch(search: string): string | null {
  const name = new URLSearchParams(search).get("workspace")?.trim() ?? "";
  return name.length > 0 ? name : null;
}
