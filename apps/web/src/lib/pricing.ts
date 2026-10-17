/**
 * Pricing copy, shared by /pricing (HTML) and /pricing.md (raw Markdown) so
 * the two cannot diverge. Plan numbers come from the plan catalog (same
 * source as /docs/limits). The Pro price is set in Stripe; keep
 * PRO_PRICE in step with it when the introductory price changes.
 */
import { PLAN_FACTS as P } from "./plan-facts";

const PRO_PRICE = "$10";

export const PRICING_TITLE = "Pricing";
export const PRICING_DESCRIPTION =
  "Start free on hosted uploads.sh, move to Pro for teams, or bring your own bucket on any plan. Self-hosting the open-source service is the fallback.";

export const PRICING_MARKDOWN = `# Pricing

> **uploads.sh** hosts screenshots, recordings, and other files for agents and
> humans, and puts them on GitHub pull requests and issues. For most people the
> hosted service is the easiest place to start: sign in, install the CLI or
> connect the MCP server, and you are uploading in a few minutes.

## Summary

- **${P.freeName}** — $0, no card required, no time limit. Start here.
- **${P.proName}** — ${PRO_PRICE} per month per workspace (introductory price),
  for teams that need more storage and larger files.
- **Bring your own bucket** — on any plan, including ${P.freeName}. Storage in
  your own bucket has no uploads.sh storage cap; you pay your storage provider
  directly.
- **Self-host** — the fallback. The service is open source (Apache-2.0), so if
  hosted uploads.sh doesn't fit, you can run it on your own infrastructure. Expect
  to set up and operate several workers, storage, and a database yourself.
  [Source on GitHub](https://github.com/buildinternet/uploads).

## Plans

Limits apply per workspace, not per user. Everyone in a workspace shares them.

| | ${P.freeName} | ${P.proName} |
| --- | --- | --- |
| Price | $0 | ${PRO_PRICE} per month per workspace (introductory) |
| Hosted storage | ${P.freeStorage} | ${P.proStorage} |
| Max file size | ${P.freeMaxUpload} | ${P.proMaxUpload} |
| Max video size | ${P.freeMaxVideo} | ${P.proMaxVideo} |
| Members | ${P.freeMembers} | Unlimited |
| Bring your own bucket | Yes | Yes |
| CLI, hosted MCP server, REST API, GitHub App | Yes | Yes |

Both plans include every product surface. ${P.proName} raises the caps; it does
not unlock features.

Some optional AI features may be billed by usage in the future. They will be
opt-in, and the plan prices above do not change because of them.

## Bring your own bucket

Point a workspace at your own Cloudflare R2 or S3-compatible bucket. Files go to
storage you own and pay for, and uploads.sh never holds a copy. The plan's
storage cap only counts files on hosted storage, so storage in your bucket is
unmetered. File-size caps still apply.

Setup: [Bring your own bucket](https://uploads.sh/docs/byo-bucket).

## Fair use

Every workspace has API rate limits and a monthly upload budget to stop
automated abuse. They are set well above normal use, including heavy
agent-driven use. A refused request returns \`429\`; see
[rate limits](https://uploads.sh/docs/api#rate-limits). If you need more for a
legitimate use, email [hi@uploads.sh](mailto:hi@uploads.sh).

## Upgrading and billing

- A workspace owner or admin subscribes to ${P.proName} from the workspace's
  billing tab. Stripe processes payment, and checkout shows the final price,
  including any tax.
- Cancel at any time. The workspace stays on ${P.proName} until the end of the
  paid period.
- A downgrade never deletes files. Existing links keep working.

Full terms: [Terms of Service](https://uploads.sh/terms).

## More

- [Plans & limits](https://uploads.sh/docs/limits): what happens at each cap
- [Docs](https://uploads.sh/docs): install and get started
- [pricing.md](https://uploads.sh/pricing.md): this page as Markdown
- [llms.txt](https://uploads.sh/llms.txt): agent guide
- [auth.md](https://uploads.sh/auth.md): auth for agents
`;
