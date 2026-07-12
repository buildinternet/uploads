import { ConflictError, NotFoundError, RateLimitedError, ValidationError } from "@uploads/errors";
import { Hono } from "hono";
import { adminAuth } from "../admin";
import {
  DEFAULT_ENROLLMENT_SECONDS,
  DEFAULT_TOKEN_SECONDS,
  FILE_SCOPES,
  MAX_TOKEN_SECONDS,
  createEnrollment,
  createToken,
  listTokens,
  parseScopes,
  revokeToken,
  validateScopes,
} from "../auth-db";
import { reencryptRegistryCredentials } from "../reencrypt-registry";
import type { WorkspaceRecord } from "../workspace";

const WS_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const HASH_PREFIX_LEN = 8;
const SECONDS_PER_DAY = 24 * 60 * 60;
// Ceiling for --expires-in. 24h caps how long a single-use invite secret can
// live; the floor stays 60s at the validation site below.
const MAX_ENROLLMENT_SECONDS = SECONDS_PER_DAY;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Invitations are delivered from this address; uploads.sh is onboarded for
// Cloudflare Email Sending, so any @uploads.sh sender works.
const INVITE_FROM = { name: "uploads.sh", email: "invites@uploads.sh" } as const;

// The invite page lives on the web origin, which mirrors the API host without
// the `api.` prefix (api.uploads.sh -> uploads.sh), matching the CLI default.
function deriveWebOrigin(requestUrl: string): string {
  const url = new URL(requestUrl);
  url.hostname = url.hostname.replace(/^api\./, "");
  return url.origin;
}

// Self-contained magic link: the single-use code rides in the URL fragment, which
// browsers never send to a server, so it stays out of logs and referrers.
function inviteMagicLink(webOrigin: string, pageId: string, code: string): string {
  return `${webOrigin}/invite?id=${encodeURIComponent(pageId)}#code=${encodeURIComponent(code)}`;
}

function renderInviteEmail(to: string, workspaceName: string, link: string, expiresAt: string) {
  const expires = new Date(expiresAt).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
  const webOrigin = new URL(link).origin;
  // "default" is the shared entry workspace — naming it reads as jargon, so that
  // case is framed as access to uploads.sh itself.
  const isDefault = workspaceName === "default";
  const invitedTo = isDefault
    ? "You've been given access to uploads.sh"
    : `You've been invited to the ${workspaceName} workspace on uploads.sh`;
  const pitch =
    "an easy way to include screenshots and media in your GitHub pull requests, straight from the terminal";
  const text = [
    `${invitedTo} — ${pitch}.`,
    "",
    "Accept your invitation (you'll need to do this from your laptop, not your phone):",
    `${link}`,
    "",
    `This link works once and expires ${expires}. If you weren't expecting it,`,
    "you can safely ignore this email.",
    "",
    "—",
    "uploads.sh · a Build Internet project",
    `Terms: ${webOrigin}/terms · Privacy: ${webOrigin}/privacy`,
  ].join("\n");
  // Email-client HTML: tables for layout, inline styles, explicit hex colors so the
  // dark card renders intentionally in both light- and dark-mode clients.
  const mono = "ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace";
  const preheader = `${invitedTo} — one click to accept, link expires ${expires}.`;
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background-color:#0b0813;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0b0813;">
<tr><td align="center" style="padding:40px 16px;">
  <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
    <tr><td style="font-family:${mono};font-size:13px;letter-spacing:.08em;color:#b794ff;padding:0 4px 14px;">&#9650; uploads.sh</td></tr>
    <tr><td style="background-color:#151024;border:1px solid #2b1f46;border-radius:12px;padding:36px 34px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-family:${mono};font-size:24px;line-height:1.3;font-weight:700;color:#f2edfb;padding-bottom:12px;">You're invited</td></tr>
        <tr><td style="font-family:${mono};font-size:14px;line-height:1.7;color:#b9b0cf;padding-bottom:26px;">${
          isDefault
            ? `You've been given access to <strong style="color:#f2edfb;">uploads.sh</strong>`
            : `You've been invited to the <strong style="color:#f2edfb;">${workspaceName}</strong> workspace on uploads.sh`
        } &mdash; an easy way to include screenshots and media in your GitHub pull requests, straight from the terminal.</td></tr>
        <tr><td>
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="background-color:#b794ff;border-radius:8px;">
              <a href="${link}" style="display:inline-block;padding:13px 26px;font-family:${mono};font-size:15px;font-weight:700;color:#171128;text-decoration:none;">Accept invitation &rarr;</a>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="font-family:${mono};font-size:12px;line-height:1.6;color:#8e86a5;padding-top:14px;">You'll need to do this from your laptop, not your phone.</td></tr>
        <tr><td style="padding-top:26px;"><div style="border-top:1px solid #2b1f46;"></div></td></tr>
        <tr><td style="font-family:${mono};font-size:12px;line-height:1.7;color:#8e86a5;padding-top:18px;">This link works once and expires <span style="color:#b9b0cf;">${expires}</span>. If you weren't expecting it, you can safely ignore this email.</td></tr>
      </table>
    </td></tr>
    <tr><td align="center" style="font-family:${mono};font-size:11px;line-height:1.8;color:#6f6787;padding:22px 4px 0;">
      uploads.sh &middot; a <a href="https://buildinternet.com" style="color:#8e86a5;text-decoration:underline;">Build Internet</a> project<br>
      <a href="${webOrigin}/terms" style="color:#8e86a5;text-decoration:underline;">Terms</a> &nbsp;&middot;&nbsp; <a href="${webOrigin}/privacy" style="color:#8e86a5;text-decoration:underline;">Privacy</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
  return {
    to,
    from: INVITE_FROM,
    subject: isDefault
      ? "You've been given access to uploads.sh"
      : `You're invited to ${workspaceName} on uploads.sh`,
    text,
    html,
  };
}

interface LegacyToken {
  hash: string;
  label?: string;
  createdAt: string;
}

/** Token list for a record, migrating a legacy `tokenHash`-only record into the list shape. */
function legacyTokens(record: WorkspaceRecord): LegacyToken[] {
  return (
    record.tokens ??
    (record.tokenHash ? [{ hash: record.tokenHash, createdAt: new Date(0).toISOString() }] : [])
  );
}

async function workspace(c: { env: Env }, name: string): Promise<WorkspaceRecord | null> {
  return c.env.REGISTRY.get<WorkspaceRecord>(`ws:${name}`, { type: "json" });
}

function validInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function labelValue(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const label = value.trim();
  return label.length >= 1 && label.length <= 100 ? label : null;
}

function requireWorkspaceName(name: string): void {
  if (!WS_NAME_RE.test(name)) {
    throw new ValidationError("invalid workspace", { code: "invalid_workspace" });
  }
}

function requireLabel(label: string | undefined | null): asserts label is string | undefined {
  if (label === null) {
    throw new ValidationError("label must be between 1 and 100 characters", {
      code: "invalid_label",
    });
  }
}

const EMAIL_VALID_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const admin = new Hono<{ Bindings: Env }>()
  .use("/*", adminAuth)

  // D9 fallback: ADMIN_TOKEN-gated first-admin/second-admin promotion,
  // proxying to the auth worker's internal-only promote-admin endpoint over
  // the AUTH service binding. Stays on adminAuth (not sessionAuth) — this is
  // explicitly the ops/CI fallback path, not part of the session-auth admin
  // UI surface (that's requireAdminUser, added alongside but not wired to any
  // route yet — see src/session-auth.ts).
  .post("/users/promote", async (c) => {
    const body = await c.req.json<{ email?: unknown }>().catch(() => ({}) as { email?: unknown });
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email || !EMAIL_VALID_RE.test(email)) {
      throw new ValidationError("invalid email address", { code: "invalid_email" });
    }

    // x-uploads-internal marks this as a service-binding call (see
    // apps/auth/src/internal.ts); cf-connecting-ip is never set on a binding
    // fetch(), so there is nothing to strip here.
    const response = await c.env.AUTH.fetch("https://auth.internal/internal/promote-admin", {
      method: "POST",
      headers: { "content-type": "application/json", "x-uploads-internal": "1" },
      body: JSON.stringify({ email }),
    });
    const payload = await response.json().catch(() => null);

    if (response.status === 404) {
      throw new NotFoundError("no user with that email", { code: "user_not_found" });
    }
    if (!response.ok) {
      throw new ValidationError("promote-admin failed", { details: payload });
    }
    return c.json(payload as object, 200);
  })

  // Mint a scoped bearer token for an existing workspace (defaults to "default").
  // New credentials live in D1; legacy KV credentials remain readable/revocable.
  .post("/tokens", async (c) => {
    const body = await c.req
      .json<{
        workspace?: string;
        label?: string;
        scopes?: unknown;
        expiresInDays?: number;
      }>()
      .catch(
        () =>
          ({}) as {
            workspace?: string;
            label?: string;
            scopes?: unknown;
            expiresInDays?: number;
          },
      );
    const name = body.workspace?.trim() || "default";
    const label = labelValue(body.label);
    requireWorkspaceName(name);
    requireLabel(label);
    if (!(await workspace(c, name))) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const scopes = validateScopes(body.scopes, [...FILE_SCOPES]);
    if (!scopes) throw new ValidationError("invalid scopes", { code: "invalid_scopes" });
    if (
      body.expiresInDays !== undefined &&
      !validInteger(body.expiresInDays, 1, MAX_TOKEN_SECONDS / SECONDS_PER_DAY)
    ) {
      throw new ValidationError(
        `expiresInDays must be between 1 and ${MAX_TOKEN_SECONDS / SECONDS_PER_DAY}`,
        { code: "invalid_expires" },
      );
    }

    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000)
      : undefined;
    const created = await createToken(c.env.DB, {
      workspace: name,
      label,
      scopes,
      expiresAt,
    });
    return c.json(
      {
        workspace: name,
        token: created.token,
        label: label ?? null,
        scopes,
        expiresAt: created.record.expires_at,
      },
      201,
    );
  })

  // Create a one-time login code. The code itself is returned once and only its
  // hash is persisted. Exchanged tokens default to 90 days and read/write.
  .post("/enrollments", async (c) => {
    c.header("Cache-Control", "no-store");
    const body = await c.req
      .json<{
        workspace?: string;
        label?: string;
        scopes?: unknown;
        enrollmentSeconds?: number;
        tokenExpiresInSeconds?: number;
        email?: string;
      }>()
      .catch(
        () =>
          ({}) as {
            workspace?: string;
            label?: string;
            scopes?: unknown;
            enrollmentSeconds?: number;
            tokenExpiresInSeconds?: number;
            email?: string;
          },
      );
    const name = body.workspace?.trim() || "default";
    const label = labelValue(body.label);
    requireWorkspaceName(name);
    requireLabel(label);
    if (!(await workspace(c, name))) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const scopes = validateScopes(body.scopes, ["files:read", "files:write"]);
    if (!scopes) throw new ValidationError("invalid scopes", { code: "invalid_scopes" });
    if (
      body.enrollmentSeconds !== undefined &&
      !validInteger(body.enrollmentSeconds, 60, MAX_ENROLLMENT_SECONDS)
    ) {
      throw new ValidationError(
        `enrollmentSeconds must be between 60 and ${MAX_ENROLLMENT_SECONDS}`,
        { code: "invalid_expires" },
      );
    }
    if (
      body.tokenExpiresInSeconds !== undefined &&
      !validInteger(body.tokenExpiresInSeconds, 60, MAX_TOKEN_SECONDS)
    ) {
      throw new ValidationError(
        `tokenExpiresInSeconds must be between 60 and ${MAX_TOKEN_SECONDS}`,
        { code: "invalid_expires" },
      );
    }

    const email = typeof body.email === "string" ? body.email.trim() : undefined;
    if (email !== undefined && !EMAIL_RE.test(email)) {
      throw new ValidationError("invalid email address", { code: "invalid_email" });
    }
    if (email) {
      // Rate-limit per recipient so invitations cannot be used to email-bomb a
      // victim, even with a valid admin token. Reuses the invite limiter namespace.
      const limiter = c.env.INVITE_LIMITER;
      if (limiter) {
        const { success } = await limiter.limit({ key: `invite:email:${email.toLowerCase()}` });
        if (!success) throw new RateLimitedError("invitation email rate limit exceeded");
      }
    }

    const enrollment = await createEnrollment(c.env.DB, {
      workspace: name,
      label,
      scopes,
      enrollmentSeconds: body.enrollmentSeconds ?? DEFAULT_ENROLLMENT_SECONDS,
      tokenSeconds: body.tokenExpiresInSeconds ?? DEFAULT_TOKEN_SECONDS,
    });

    let emailed: boolean | undefined;
    if (email) {
      const webOrigin = c.env.WEB_ORIGIN || deriveWebOrigin(c.req.url);
      const link = inviteMagicLink(webOrigin, enrollment.pageId, enrollment.code);
      try {
        await c.env.EMAIL.send(renderInviteEmail(email, name, link, enrollment.expiresAt));
        emailed = true;
        // Audit only non-secret metadata — never the code, magic link, or URL.
        console.log(
          JSON.stringify({
            event: "invite_emailed",
            workspace: name,
            recipient: email,
            pageId: enrollment.pageId,
          }),
        );
      } catch (error) {
        emailed = false;
        console.log(
          JSON.stringify({
            event: "invite_email_failed",
            workspace: name,
            recipient: email,
            pageId: enrollment.pageId,
            error: (error as { code?: string }).code ?? (error as Error).message,
          }),
        );
      }
    }

    return c.json({ workspace: name, label: label ?? null, scopes, emailed, ...enrollment }, 201);
  })

  // Lists D1 credentials and legacy KV credentials without exposing secrets.
  .get("/tokens", async (c) => {
    const name = c.req.query("workspace")?.trim() || "default";
    requireWorkspaceName(name);
    const record = await workspace(c, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }

    const d1 = (await listTokens(c.env.DB, name)).map((token) => ({
      label: token.label,
      createdAt: token.created_at,
      hashPrefix: token.token_hash.slice(0, HASH_PREFIX_LEN),
      scopes: parseScopes(token.scopes),
      expiresAt: token.expires_at,
      revokedAt: token.revoked_at,
      source: "d1" as const,
    }));
    const legacy = legacyTokens(record).map((token) => ({
      label: token.label ?? null,
      createdAt: token.createdAt,
      hashPrefix: token.hash.slice(0, HASH_PREFIX_LEN),
      scopes: [...FILE_SCOPES],
      expiresAt: null,
      revokedAt: null,
      source: "legacy" as const,
    }));
    return c.json({ workspace: name, tokens: [...legacy, ...d1] });
  })

  // Revoke an active D1 or legacy KV token by hash prefix or label.
  .delete("/tokens", async (c) => {
    const body = await c.req
      .json<{ workspace?: string; hashPrefix?: string; label?: string }>()
      .catch(() => ({}) as { workspace?: string; hashPrefix?: string; label?: string });
    const name = body.workspace?.trim() || "default";
    const hashPrefix = body.hashPrefix?.trim();
    const label = body.label?.trim();
    requireWorkspaceName(name);
    if (!hashPrefix && !label) {
      throw new ValidationError("hashPrefix or label required", {
        code: "hash_prefix_or_label_required",
      });
    }

    const record = await workspace(c, name);
    if (!record) {
      throw new NotFoundError("workspace not found", { code: "workspace_not_found" });
    }
    const kv = legacyTokens(record);
    const kvMatches = kv.filter((token) =>
      hashPrefix ? token.hash.startsWith(hashPrefix) : token.label === label,
    );
    const activeD1 = (await listTokens(c.env.DB, name)).filter(
      (token) =>
        token.revoked_at === null &&
        (hashPrefix ? token.token_hash.startsWith(hashPrefix) : token.label === label),
    );
    const count = kvMatches.length + activeD1.length;
    if (count === 0) throw new NotFoundError("no matching token");
    if (count > 1) throw new ConflictError("selector matches multiple tokens");

    if (activeD1.length === 1) {
      const result = await revokeToken(c.env.DB, name, { hashPrefix, label });
      if (!result.match) throw new NotFoundError("no matching token");
      return c.json({
        workspace: name,
        revoked: {
          label: result.match.label,
          hashPrefix: result.match.token_hash.slice(0, HASH_PREFIX_LEN),
        },
      });
    }

    const revoked = kvMatches[0];
    const remaining = kv.filter((token) => token !== revoked);
    const { tokenHash: _drop, ...rest } = record;
    await c.env.REGISTRY.put(`ws:${name}`, JSON.stringify({ ...rest, tokens: remaining }));
    return c.json({
      workspace: name,
      revoked: { label: revoked.label ?? null, hashPrefix: revoked.hash.slice(0, HASH_PREFIX_LEN) },
    });
  })

  /**
   * Re-seal BYO S3 credentials under WORKSPACE_SECRETS_KEY (current).
   * Decrypt tries current then WORKSPACE_SECRETS_KEY_PREVIOUS.
   * Prefer this over a laptop script so the KEK never leaves the worker.
   * Query: ?dryRun=1
   */
  .post("/credentials/reencrypt", async (c) => {
    const dryRun =
      c.req.query("dryRun") === "1" ||
      c.req.query("dryRun") === "true" ||
      c.req.query("dry_run") === "1";
    try {
      const result = await reencryptRegistryCredentials(c.env, { dryRun });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ValidationError(message, { cause: err });
    }
  });
