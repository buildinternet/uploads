export interface NormalizedExternalReference {
  provider: "github";
  resourceType: "item";
  normalizedKey: string;
  locator: { owner: string; repository: string; number: number };
  canonicalUrl: string;
}

export type ExternalReferenceParseResult =
  | { ok: true; value: NormalizedExternalReference }
  | { ok: false; message: string };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;

export function parseExternalReference(
  provider: unknown,
  coordinate: unknown,
): ExternalReferenceParseResult {
  if (typeof provider !== "string" || provider.trim().toLowerCase() !== "github")
    return { ok: false, message: "provider must be github" };
  if (typeof coordinate !== "string")
    return { ok: false, message: "coordinate must be owner/repo#number" };
  const match = /^([^/]+)\/([^#]+)#([1-9][0-9]*)$/.exec(coordinate.trim());
  if (
    !match ||
    !OWNER.test(match[1]) ||
    !REPOSITORY.test(match[2]) ||
    match[2] === "." ||
    match[2] === ".."
  )
    return { ok: false, message: "coordinate must be owner/repo#number" };
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) return { ok: false, message: "issue number is too large" };
  const owner = match[1].toLowerCase();
  const repository = match[2].toLowerCase();
  return {
    ok: true,
    value: {
      provider: "github",
      resourceType: "item",
      normalizedKey: `github:item:${owner}/${repository}#${number}`,
      locator: { owner, repository, number },
      canonicalUrl: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${number}`,
    },
  };
}
