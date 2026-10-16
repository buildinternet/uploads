/**
 * Copy for a missing file scope. The API 403, the CLI, and the hosted MCP
 * tool error all say the same thing: which scope, and where to get it.
 */
export function scopeRemedy(scope: string): string {
  return `Ask a workspace admin, or mint a token with ${scope} at https://uploads.sh/account/developers.`;
}

export function insufficientScopeMessage(scope: string): string {
  return `This token needs the ${scope} scope. ${scopeRemedy(scope)}`;
}
