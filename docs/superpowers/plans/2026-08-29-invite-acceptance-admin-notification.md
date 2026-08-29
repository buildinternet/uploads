# Invite-acceptance Admin Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email a workspace's admins/owners when a new member joins (via either join path), gated by a per-user, on-by-default notification preference editable on the account profile page.

**Architecture:** All storage, join logic, and member/user data live in the AUTH worker (`apps/auth`). A new `notifyAdminsOfMemberJoin` helper queries admin/owner members whose preference is on (excluding the joiner, and the inviter on the invite path) and sends a new `@uploads/email` template via the existing `sendAuthEmail`. The preference is one boolean column on `user`, declared as a better-auth `additionalField` so `POST /api/auth/update-user` writes it and the session returns it; the profile page toggles it through that endpoint via the existing same-origin auth proxy.

**Tech Stack:** Cloudflare Workers, Hono, better-auth (organization plugin), Drizzle ORM over D1, `@uploads/email` (card templates + Cloudflare Email Sending), Astro (SSR, bundled TS `<script>`, no React), Vitest with the `createFakeD1` harness.

**Spec:** [`docs/superpowers/specs/2026-08-29-invite-acceptance-admin-notification-design.md`](../specs/2026-08-29-invite-acceptance-admin-notification-design.md)

## Global Constraints

- **Migration chain:** the AUTH worker's D1 tables are migrated from `apps/api/migrations/*.sql` ONLY. The `apps/auth/migrations/` chain is retired (see `apps/auth/src/test/fake-d1.ts`). D1 migrations auto-apply to prod on merge to `main`.
- **Mail is fire-and-forget:** `sendAuthEmail` never throws; a mail (or recipient-lookup) failure must never fail or roll back a join.
- **Sender:** always `noreply@uploads.sh` (already enforced by `sendAuthEmail`).
- **No new web client dependency:** `apps/web` ships no React; account pages are Astro with bundled TS `<script>` blocks using plain `fetch` wrappers in `apps/web/src/lib/auth-client.ts`.
- **Recipients:** members with role `admin` or `owner`, minus the joiner (and minus the inviter on the invite path). Never notify plain members.
- **Default:** `notify_member_join` defaults to `1` (on) for new and existing rows.
- **Copy rule:** no sensational words ("comprehensive", "world-class"). Terminal/product voice matching sibling templates.
- **Test runner:** plain Vitest, in-process fakes; `pnpm test` at repo root, or `pnpm --filter @uploads/<pkg> test`.
- **Typecheck:** `pnpm --filter @uploads/auth types`, `pnpm --filter @uploads/web types`, `pnpm --filter @uploads/email types`, `pnpm --filter @uploads/api types` as touched.

---

## File Structure

**Create:**

- `apps/api/migrations/20260829120000_auth_user_notify_member_join.sql` — adds the column.
- `apps/auth/src/notify-member-join.ts` — the `notifyAdminsOfMemberJoin` helper.
- `apps/auth/src/notify-member-join.test.ts` — helper unit tests.

**Modify:**

- `apps/auth/src/schema.ts` — add `notifyMemberJoin` to the `user` table.
- `apps/auth/src/auth.ts` — declare the `additionalField`; call the helper in `afterAcceptInvitation`.
- `apps/auth/src/internal-routes.ts` — call the helper in the `/internal/join` fresh-insert branch.
- `apps/auth/src/email.ts` — add the `member-join-admin-notice` arm to `SendAuthEmailArgs` + `render()`.
- `packages/email/src/invites.ts` — add `renderMemberJoinAdminNoticeEmail`.
- `packages/email/src/index.ts` — export it.
- `apps/api/src/admin-email-preview.ts` — register the preview type.
- `apps/web/src/lib/auth-client.ts` — add `notifyMemberJoin` to `SessionUser`; add `updateNotifyMemberJoin`.
- `apps/web/src/pages/account/profile.astro` — add the "Email notifications" section + toggle wiring.
- Test seed helpers (new NOT NULL column ⇒ required in `AuthUser`): `apps/auth/src/internal-routes.test.ts`, `apps/auth/src/member-cap.test.ts`, `apps/auth/src/admin-last-guard.test.ts`, `apps/auth/src/internal-metrics.test.ts`.
- `apps/auth/src/internal-routes.test.ts` — add a `/internal/join` notification integration test (Task 4).

---

## Task 1: Preference column + schema + additional field

**Files:**

- Create: `apps/api/migrations/20260829120000_auth_user_notify_member_join.sql`
- Modify: `apps/auth/src/schema.ts:36-57` (user table)
- Modify: `apps/auth/src/auth.ts:820-824` (`user.additionalFields`)
- Modify (test seeds): `apps/auth/src/internal-routes.test.ts:119-137`, `apps/auth/src/member-cap.test.ts` (lines ~35-75 and ~270-300), `apps/auth/src/admin-last-guard.test.ts:50-60`, `apps/auth/src/internal-metrics.test.ts` (its `AuthUser` builder)

**Interfaces:**

- Produces: `schema.user.notifyMemberJoin` (Drizzle boolean column, DB `notify_member_join`); `schema.AuthUser` now has a required `notifyMemberJoin: boolean`.

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/20260829120000_auth_user_notify_member_join.sql`:

```sql
-- Per-user notification preference: email me when someone joins a workspace
-- I administer. Default 1 (on) so existing admins keep getting notified; users
-- opt out on /account/profile. Declared as a better-auth additionalField in
-- apps/auth/src/auth.ts so /api/auth/update-user can write it.
ALTER TABLE user ADD COLUMN notify_member_join INTEGER NOT NULL DEFAULT 1;
```

- [ ] **Step 2: Add the column to the Drizzle schema**

In `apps/auth/src/schema.ts`, inside `export const user = sqliteTable("user", { ... })` (after `stripeCustomerId`, line ~56), add:

```ts
  /** Per-user pref: email me when someone joins a workspace I administer.
   * Default on. Declared as a better-auth additionalField (src/auth.ts) so
   * /api/auth/update-user writes it and the session returns it. */
  notifyMemberJoin: integer("notify_member_join", { mode: "boolean" })
    .notNull()
    .$defaultFn(() => true),
```

- [ ] **Step 3: Declare the better-auth additional field**

In `apps/auth/src/auth.ts`, in the `user.additionalFields` object (line ~821), add alongside `cliOnboardedAt`:

```ts
        notifyMemberJoin: {
          type: "boolean",
          required: false,
          input: true,
          defaultValue: true,
        },
```

- [ ] **Step 4: Fix the test seed builders (typecheck driver)**

The column is NOT NULL, so `schema.AuthUser` now requires `notifyMemberJoin`. In each `seedUser`/full-`AuthUser` builder listed under Files, add this line next to `stripeCustomerId`:

```ts
      notifyMemberJoin: overrides.notifyMemberJoin ?? true,
```

For builders that construct a bare literal without an `overrides` object (some in `member-cap.test.ts`), add `notifyMemberJoin: true,`.

- [ ] **Step 5: Write a failing test for the default**

Add to `apps/auth/src/internal-routes.test.ts` inside the `DB-backed behavior` describe:

```ts
it("defaults notify_member_join to on for a seeded user", async () => {
  const user = await seedUser();
  const [row] = await orm.select().from(schema.user).where(eq(schema.user.id, user.id));
  expect(row.notifyMemberJoin).toBe(true);
});
```

- [ ] **Step 6: Run it — expect PASS once migration + schema + seed land**

Run: `pnpm --filter @uploads/auth test -- internal-routes`
Expected: the new test PASSES (fake-D1 applies the new migration; seed defaults to true). If it fails to compile, an `AuthUser` builder still lacks the field — fix per Step 4.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @uploads/auth types`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/20260829120000_auth_user_notify_member_join.sql apps/auth/src/schema.ts apps/auth/src/auth.ts apps/auth/src/*.test.ts
git commit -m "feat(auth): add notify_member_join user preference column"
```

---

## Task 2: `member-join-admin-notice` email template

**Files:**

- Modify: `packages/email/src/invites.ts` (add renderer after `renderMemberJoinedEmail`, line ~104)
- Modify: `packages/email/src/index.ts:10-14`
- Modify: `apps/api/src/admin-email-preview.ts:5-20,49-95`
- Test: `packages/email/src/invites.test.ts` (create if absent) or the existing email test file for the package

**Interfaces:**

- Produces: `renderMemberJoinAdminNoticeEmail(ctx: { organizationName: string; organizationSlug: string; memberEmail: string; webOrigin?: string }): RenderedEmail`

- [ ] **Step 1: Write the failing test**

Create `packages/email/src/invites.test.ts` (or append to the package's existing test file):

```ts
import { describe, expect, it } from "vitest";
import { renderMemberJoinAdminNoticeEmail } from "./invites";

describe("renderMemberJoinAdminNoticeEmail", () => {
  it("renders subject, body, manage CTA, and settings footnote", () => {
    const email = renderMemberJoinAdminNoticeEmail({
      organizationName: "Acme",
      organizationSlug: "acme",
      memberEmail: "new@example.com",
      webOrigin: "https://uploads.sh",
    });
    expect(email.subject).toContain("Acme");
    expect(email.subject.toLowerCase()).toContain("joined");
    expect(email.html).toContain("new@example.com");
    expect(email.html).toContain("https://uploads.sh/account/workspaces/acme/settings");
    expect(email.html).toContain("https://uploads.sh/account/profile");
    expect(email.text).toContain("new@example.com");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @uploads/email test -- invites`
Expected: FAIL — `renderMemberJoinAdminNoticeEmail` is not exported.

- [ ] **Step 3: Implement the renderer**

In `packages/email/src/invites.ts`, after `renderMemberJoinedEmail` (line ~104), add:

```ts
/** Notify a workspace's admins/owners when a new member joins (either path). */
export function renderMemberJoinAdminNoticeEmail(ctx: {
  organizationName: string;
  organizationSlug: string;
  memberEmail: string;
  webOrigin?: string;
}): RenderedEmail {
  const origin = (ctx.webOrigin ?? "https://uploads.sh").replace(/\/$/, "");
  const manageUrl = `${origin}/account/workspaces/${ctx.organizationSlug}/settings`;
  const settingsUrl = `${origin}/account/profile`;
  const lead = `${ctx.memberEmail} joined ${ctx.organizationName} on uploads.sh.`;
  return renderEmailCard({
    subject: `${ctx.memberEmail} joined ${ctx.organizationName} on uploads.sh`,
    preheader: lead,
    eyebrow: "Membership",
    title: "New member joined",
    bodyHtml: `${strong(ctx.memberEmail)} joined ${strong(ctx.organizationName)} on uploads.sh.`,
    text: [
      lead,
      "",
      `Manage members: ${manageUrl}`,
      "",
      "—",
      "uploads.sh · a Build Internet project",
      `Turn this notification off in your account settings: ${settingsUrl}`,
    ].join("\n"),
    cta: { url: manageUrl, label: "Manage members →" },
    footNoteHtml: `You administer this workspace. <a href="${settingsUrl}" style="color:#b9b0cf;">Manage notifications</a> to turn this off.`,
    webOrigin: ctx.webOrigin,
  });
}
```

- [ ] **Step 4: Export it**

In `packages/email/src/index.ts`, add `renderMemberJoinAdminNoticeEmail` to the `./invites` export block:

```ts
export {
  renderEnrollmentInvitationEmail,
  renderMemberJoinAdminNoticeEmail,
  renderMemberJoinedEmail,
  renderOrgInvitationEmail,
} from "./invites";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @uploads/email test -- invites`
Expected: PASS.

- [ ] **Step 6: Register the operator preview**

In `apps/api/src/admin-email-preview.ts`:

- Add `renderMemberJoinAdminNoticeEmail` to the `@uploads/email` import (line 5-11).
- Add to `EMAIL_PREVIEW_TYPES` (after the `member-joined` entry, line 17):

```ts
  { id: "member-join-admin-notice", label: "Admin: member joined notify", category: "Auth" },
```

- Add a `renderPreview` case (after the `member-joined` case, line 77):

```ts
    case "member-join-admin-notice":
      return {
        from: AUTH_FROM,
        ...renderMemberJoinAdminNoticeEmail({
          organizationName: "preview-workspace",
          organizationSlug: "preview-workspace",
          memberEmail: "new-member@example.com",
          webOrigin: origin,
        }),
      };
```

- [ ] **Step 7: Typecheck email + api**

Run: `pnpm --filter @uploads/email types && pnpm --filter @uploads/api types`
Expected: clean (the `renderPreview` switch is now exhaustive over the extended `EmailPreviewType`).

- [ ] **Step 8: Commit**

```bash
git add packages/email/src/invites.ts packages/email/src/index.ts packages/email/src/invites.test.ts apps/api/src/admin-email-preview.ts
git commit -m "feat(email): add member-join admin notice template"
```

---

## Task 3: `notifyAdminsOfMemberJoin` helper + email dispatch arm

**Files:**

- Create: `apps/auth/src/notify-member-join.ts`
- Create: `apps/auth/src/notify-member-join.test.ts`
- Modify: `apps/auth/src/email.ts:33-49` (union), `apps/auth/src/email.ts:51-62` (`render`), import (line 7-13)

**Interfaces:**

- Consumes: `sendAuthEmail` (`apps/auth/src/email.ts`), `schema.member`, `schema.user` (`apps/auth/src/schema.ts`).
- Produces:

  ```ts
  export interface NotifyAdminsOfMemberJoinOpts {
    organizationId: string;
    organizationName: string;
    organizationSlug: string;
    joinerUserId: string;
    joinerEmail: string;
    excludeUserIds?: string[];
  }
  export function notifyAdminsOfMemberJoin(
    env: SendAuthEmailEnv,
    db: DrizzleD1Database<typeof schema>,
    opts: NotifyAdminsOfMemberJoinOpts,
  ): Promise<void>;
  ```

- [ ] **Step 1: Add the email dispatch arm**

In `apps/auth/src/email.ts`:

- Import the renderer (line 7-13 block): add `renderMemberJoinAdminNoticeEmail,`.
- Add to `SendAuthEmailArgs` (after the `member-joined` arm, line 44):

```ts
  | {
      to: string;
      template: "member-join-admin-notice";
      context: { organizationName: string; organizationSlug: string; memberEmail: string };
    }
```

- Add to `render()` switch (after the `member-joined` case, line 58):

```ts
    case "member-join-admin-notice":
      return renderMemberJoinAdminNoticeEmail({ ...args.context, webOrigin });
```

- [ ] **Step 2: Write the failing helper test**

Create `apps/auth/src/notify-member-join.test.ts`:

```ts
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailBinding } from "./email";
import { notifyAdminsOfMemberJoin } from "./notify-member-join";
import * as schema from "./schema";
import { createFakeD1, type FakeD1Database } from "./test/fake-d1";

describe("notifyAdminsOfMemberJoin", () => {
  let db: FakeD1Database;
  let orm: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(() => {
    db = createFakeD1();
    orm = drizzle(db, { schema });
  });

  async function seedUser(over: Partial<schema.AuthUser> = {}): Promise<schema.AuthUser> {
    const u: schema.AuthUser = {
      id: over.id ?? crypto.randomUUID(),
      name: "U",
      email: over.email ?? `u-${crypto.randomUUID()}@example.com`,
      emailVerified: true,
      image: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      role: "user",
      banned: null,
      banReason: null,
      banExpires: null,
      cliOnboardedAt: null,
      stripeCustomerId: null,
      notifyMemberJoin: over.notifyMemberJoin ?? true,
    };
    await orm.insert(schema.user).values(u);
    return u;
  }

  async function seedMember(organizationId: string, userId: string, role: string): Promise<void> {
    await orm.insert(schema.member).values({
      id: crypto.randomUUID(),
      organizationId,
      userId,
      role,
      createdAt: new Date(),
    });
  }

  function emailCapture(): { EMAIL: EmailBinding; send: ReturnType<typeof vi.fn> } {
    const send = vi.fn().mockResolvedValue({});
    return { EMAIL: { send }, send };
  }

  const orgId = "org-1";
  const baseEnv = { WEB_ORIGIN: "https://uploads.sh", ENVIRONMENT: "production" as const };

  it("emails admins and owners, not plain members or the joiner", async () => {
    const admin = await seedUser();
    const owner = await seedUser();
    const plain = await seedUser();
    const joiner = await seedUser();
    await seedMember(orgId, admin.id, "admin");
    await seedMember(orgId, owner.id, "owner");
    await seedMember(orgId, plain.id, "member");
    await seedMember(orgId, joiner.id, "owner"); // joiner even as owner is excluded
    const { EMAIL, send } = emailCapture();

    await notifyAdminsOfMemberJoin({ ...baseEnv, EMAIL }, orm, {
      organizationId: orgId,
      organizationName: "Acme",
      organizationSlug: "acme",
      joinerUserId: joiner.id,
      joinerEmail: joiner.email,
    });

    const recipients = send.mock.calls.map((c) => c[0].to).sort();
    expect(recipients).toEqual([admin.email, owner.email].sort());
  });

  it("skips recipients who turned the preference off", async () => {
    const admin = await seedUser({ notifyMemberJoin: false });
    const joiner = await seedUser();
    await seedMember(orgId, admin.id, "admin");
    const { EMAIL, send } = emailCapture();
    await notifyAdminsOfMemberJoin({ ...baseEnv, EMAIL }, orm, {
      organizationId: orgId,
      organizationName: "Acme",
      organizationSlug: "acme",
      joinerUserId: joiner.id,
      joinerEmail: joiner.email,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("excludes extra excludeUserIds (the inviter)", async () => {
    const inviter = await seedUser();
    const otherAdmin = await seedUser();
    const joiner = await seedUser();
    await seedMember(orgId, inviter.id, "admin");
    await seedMember(orgId, otherAdmin.id, "admin");
    const { EMAIL, send } = emailCapture();
    await notifyAdminsOfMemberJoin({ ...baseEnv, EMAIL }, orm, {
      organizationId: orgId,
      organizationName: "Acme",
      organizationSlug: "acme",
      joinerUserId: joiner.id,
      joinerEmail: joiner.email,
      excludeUserIds: [inviter.id],
    });
    const recipients = send.mock.calls.map((c) => c[0].to);
    expect(recipients).toEqual([otherAdmin.email]);
  });

  it("never throws when the DB read fails", async () => {
    const poison = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
      },
    ) as never;
    const { EMAIL, send } = emailCapture();
    await expect(
      notifyAdminsOfMemberJoin({ ...baseEnv, EMAIL }, poison, {
        organizationId: orgId,
        organizationName: "Acme",
        organizationSlug: "acme",
        joinerUserId: "j",
        joinerEmail: "j@example.com",
      }),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @uploads/auth test -- notify-member-join`
Expected: FAIL — `notify-member-join` module not found.

- [ ] **Step 4: Implement the helper**

Create `apps/auth/src/notify-member-join.ts`:

```ts
import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { sendAuthEmail, type SendAuthEmailEnv } from "./email";
import * as schema from "./schema";

export interface NotifyAdminsOfMemberJoinOpts {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  joinerUserId: string;
  joinerEmail: string;
  /** Extra userIds to skip (e.g. the inviter on the email-invite path). */
  excludeUserIds?: string[];
}

/**
 * Emails a workspace's admins/owners that a new member joined. Recipients are
 * members with role admin/owner whose `notifyMemberJoin` preference is on,
 * minus the joiner and any `excludeUserIds`. Fire-and-forget: `sendAuthEmail`
 * never throws, and the recipient lookup is wrapped so a DB failure can't fail
 * the join that triggered this.
 */
export async function notifyAdminsOfMemberJoin(
  env: SendAuthEmailEnv,
  db: DrizzleD1Database<typeof schema>,
  opts: NotifyAdminsOfMemberJoinOpts,
): Promise<void> {
  const excluded = new Set([opts.joinerUserId, ...(opts.excludeUserIds ?? [])]);
  try {
    const rows = await db
      .select({ userId: schema.member.userId, email: schema.user.email })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
      .where(
        and(
          eq(schema.member.organizationId, opts.organizationId),
          inArray(schema.member.role, ["admin", "owner"]),
          eq(schema.user.notifyMemberJoin, true),
        ),
      );

    for (const row of rows) {
      if (excluded.has(row.userId) || !row.email) continue;
      await sendAuthEmail(env, {
        to: row.email,
        template: "member-join-admin-notice",
        context: {
          organizationName: opts.organizationName,
          organizationSlug: opts.organizationSlug,
          memberEmail: opts.joinerEmail,
        },
      });
    }
  } catch (err) {
    console.error(
      "[notify-member-join] recipient lookup failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @uploads/auth test -- notify-member-join email`
Expected: PASS (helper tests + existing email tests).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @uploads/auth types`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/auth/src/notify-member-join.ts apps/auth/src/notify-member-join.test.ts apps/auth/src/email.ts
git commit -m "feat(auth): notifyAdminsOfMemberJoin helper + email dispatch arm"
```

---

## Task 4: Wire the join-link / enrollment path

**Files:**

- Modify: `apps/auth/src/internal-routes.ts:1005-1007` (`/internal/join` fresh-insert branch), imports
- Test: `apps/auth/src/internal-routes.test.ts` (DB-backed behavior describe)

**Interfaces:**

- Consumes: `notifyAdminsOfMemberJoin` (Task 3).

- [ ] **Step 1: Write the failing integration test**

Add to `apps/auth/src/internal-routes.test.ts` in the `DB-backed behavior` describe. It seeds an org, an admin member, and a joining user, then POSTs `/internal/join` and asserts the admin is emailed. Add an `EMAIL` capture to `dbEnv` via its `overrides`:

```ts
it("emails workspace admins when a new member joins via /internal/join", async () => {
  const org = await seedOrg();
  const admin = await seedUser();
  const joiner = await seedUser();
  await orm.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: org.id,
    userId: admin.id,
    role: "admin",
    createdAt: new Date(),
  });
  const send = vi.fn().mockResolvedValue({});

  const res = await app().request(
    "/internal/join",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationSlug: org.slug, userId: joiner.id }),
    },
    dbEnv({ EMAIL: { send } }),
  );

  expect(res.status).toBe(201);
  const recipients = send.mock.calls.map((c) => c[0].to);
  expect(recipients).toEqual([admin.email]);
});
```

Ensure `vi` is imported at the top of the file: `import { beforeEach, describe, expect, it, vi } from "vitest";`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @uploads/auth test -- internal-routes`
Expected: FAIL — no email sent (recipients empty), since the route doesn't notify yet.

- [ ] **Step 3: Wire the call**

In `apps/auth/src/internal-routes.ts`:

- Add the import near the top: `import { notifyAdminsOfMemberJoin } from "./notify-member-join";`
- In the `/internal/join` handler, replace the fresh-insert branch (line ~1005):

```ts
if ((insert.meta?.changes ?? 0) === 1) {
  await notifyAdminsOfMemberJoin(c.env, db, {
    organizationId: org.id,
    organizationName: org.name,
    organizationSlug: org.slug,
    joinerUserId: userId,
    joinerEmail: user.email,
  });
  return c.json({ alreadyMember: false }, 201);
}
```

(`org`, `user`, `db` are already in scope; `c.env` satisfies `SendAuthEmailEnv`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @uploads/auth test -- internal-routes`
Expected: PASS, including the pre-existing join/cap tests (a no-EMAIL `dbEnv()` still works — `sendAuthEmail` logs).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @uploads/auth types`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/auth/src/internal-routes.ts apps/auth/src/internal-routes.test.ts
git commit -m "feat(auth): notify admins on join-link membership add"
```

---

## Task 5: Wire the email-invite accept path

**Files:**

- Modify: `apps/auth/src/auth.ts:634-663` (`afterAcceptInvitation`), import

**Interfaces:**

- Consumes: `notifyAdminsOfMemberJoin` (Task 3).

**Note on testing:** Per this repo's convention (see the issue #580 comment in `apps/auth/src/auth.ts` and `auth.test.ts`), better-auth hooks are not booted in unit tests; the extracted helper is tested directly (Task 3 covers the inviter-exclusion via `excludeUserIds`). This task's verification is a typecheck plus a manual dev check (Step 4). No new unit test is added for the hook wiring itself.

- [ ] **Step 1: Add the import**

In `apps/auth/src/auth.ts`, add near the other local imports: `import { notifyAdminsOfMemberJoin } from "./notify-member-join";`

- [ ] **Step 2: Call the helper in `afterAcceptInvitation`**

In `apps/auth/src/auth.ts`, place this call so it runs UNCONDITIONALLY on every acceptance — immediately after the inviter `member-joined` block and BEFORE the `if (!user.email) return;` guard. Do NOT put it at the end of the hook: the welcome-email block is preceded by two early returns (`if (!user.email) return;` and the first-membership gate `if (memberships.length !== 1) return;`), so a call placed there would only fire on the joiner's first-ever membership and would skip admins when an existing user joins a second workspace. Add:

```ts
// Notify the workspace's other admins/owners. The inviter already
// got the tailored `member-joined` email above, so exclude them to
// avoid a double-send; the joiner is always excluded by the helper.
await notifyAdminsOfMemberJoin(env, db, {
  organizationId: org.id,
  organizationName: org.name,
  organizationSlug: org.slug,
  joinerUserId: user.id,
  joinerEmail: user.email,
  excludeUserIds: invitation.inviterId ? [invitation.inviterId] : [],
});
```

(`env`, `db`, `org`, `user`, `invitation` are all in the hook's scope. Confirm `org.slug` is present on the hook's `organization` argument — the organization plugin passes the full org row.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @uploads/auth types`
Expected: clean. If `org.slug` is not typed on the hook argument, read `organization.slug` from the org row via a `db` lookup by `org.id` instead, or use the value already destructured.

- [ ] **Step 4: Manual dev verification**

Run the local auth stack; accept an org invite for a workspace that has a second admin whose `notify_member_join` is on. Confirm the auth worker log shows a `member-join-admin-notice` send to the second admin and NOT to the inviter or the joiner. (No EMAIL binding locally ⇒ `sendAuthEmail` logs the recipient + subject.)

- [ ] **Step 5: Commit**

```bash
git add apps/auth/src/auth.ts
git commit -m "feat(auth): notify admins on invite acceptance"
```

---

## Task 6: Account settings toggle

**Files:**

- Modify: `apps/web/src/lib/auth-client.ts:47-57` (`SessionUser`), and add `updateNotifyMemberJoin` (near `linkGitHub`, ~line 279)
- Modify: `apps/web/src/pages/account/profile.astro` (markup + `<script>`)
- Test: `apps/web/src/lib/auth-client.test.ts` (create if absent) for `updateNotifyMemberJoin`

**Interfaces:**

- Consumes: `authOrigin` (`apps/web/src/lib/auth-client.ts:42`), `fetchWithTimeout` (`./request`).
- Produces: `SessionUser.notifyMemberJoin?: boolean | null`; `updateNotifyMemberJoin(origin: string, value: boolean): Promise<boolean>`.

- [ ] **Step 1: Add the type field**

In `apps/web/src/lib/auth-client.ts`, in `interface SessionUser` (line 47), add:

```ts
  /** Per-user pref: email me when someone joins a workspace I administer. */
  notifyMemberJoin?: boolean | null;
```

- [ ] **Step 2: Write the failing client-helper test**

Create `apps/web/src/lib/auth-client.test.ts` (or append):

```ts
import { describe, expect, it, vi } from "vitest";
import { updateNotifyMemberJoin } from "./auth-client";

describe("updateNotifyMemberJoin", () => {
  it("POSTs update-user with the boolean and returns true on ok", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const ok = await updateNotifyMemberJoin("", false);
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/auth/update-user");
    expect(JSON.parse(String(init?.body))).toEqual({ notifyMemberJoin: false });
    fetchMock.mockRestore();
  });

  it("returns false on a non-ok response", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("nope", { status: 500 }));
    expect(await updateNotifyMemberJoin("", true)).toBe(false);
    fetchMock.mockRestore();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @uploads/web test -- auth-client`
Expected: FAIL — `updateNotifyMemberJoin` is not exported.

- [ ] **Step 4: Implement the helper**

In `apps/web/src/lib/auth-client.ts`, add (near `linkGitHub`):

```ts
/**
 * Write the "email me when someone joins a workspace I administer" preference
 * via Better Auth's update-user endpoint (the field is an `input: true`
 * additionalField). Same-origin through the /api/auth proxy; session cookie
 * rides along. Returns false on any failure so the toggle can revert.
 */
export async function updateNotifyMemberJoin(origin: string, value: boolean): Promise<boolean> {
  try {
    const res = await fetch(`${authOrigin(origin)}/api/auth/update-user`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notifyMemberJoin: value }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @uploads/web test -- auth-client`
Expected: PASS.

- [ ] **Step 6: Add the settings section markup**

In `apps/web/src/pages/account/profile.astro`, after the "Account" `.settings-section` (closes at line ~41), add a new section. The checkbox initial state comes from the SSR `initial.user`:

```astro
    <div class="settings-section">
      <h2>Email notifications</h2>
      <label class="notify-row">
        <input
          type="checkbox"
          id="notify-member-join"
          checked={initial.user?.notifyMemberJoin ?? true}
        />
        <span>Email me when someone joins a workspace I administer.</span>
      </label>
      <p id="notify-status" class="muted settings-note" role="status" aria-live="polite"></p>
    </div>
```

- [ ] **Step 7: Wire the toggle in the page `<script>`**

In the `profile.astro` `<script>`, import the helper (add to the `auth-client` import list, line ~143):

```ts
      updateNotifyMemberJoin,
```

Inside `onAstroPageLoad(() => { ... })`, after the existing setup, add:

```ts
const notifyToggle = document.getElementById("notify-member-join") as HTMLInputElement | null;
const notifyStatus = document.getElementById("notify-status");
notifyToggle?.addEventListener("change", () => {
  void (async () => {
    const desired = notifyToggle.checked;
    notifyToggle.disabled = true;
    if (notifyStatus) notifyStatus.textContent = "Saving…";
    const ok = await updateNotifyMemberJoin(authOrigin, desired);
    if (!ok) {
      notifyToggle.checked = !desired; // revert
      if (notifyStatus) notifyStatus.textContent = "Couldn’t save — try again.";
    } else if (notifyStatus) {
      notifyStatus.textContent = desired ? "You’ll be notified." : "Notifications off.";
    }
    notifyToggle.disabled = false;
  })();
});
```

And reconcile from the live session inside the existing `onSession((user) => { ... })` callback (line ~392):

```ts
if (notifyToggle && typeof user.notifyMemberJoin === "boolean") {
  notifyToggle.checked = user.notifyMemberJoin;
}
```

- [ ] **Step 8: Typecheck web**

Run: `pnpm --filter @uploads/web types`
Expected: clean.

- [ ] **Step 9: Browser verification**

Start the local web + auth stack. Open `/account/profile`, toggle the checkbox off → the `POST /api/auth/update-user` returns 200 and the status reads "Notifications off."; reload → the checkbox stays off (session reflects the stored value). Toggle back on. Capture a screenshot of the new section for the PR.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/lib/auth-client.ts apps/web/src/lib/auth-client.test.ts apps/web/src/pages/account/profile.astro
git commit -m "feat(web): account toggle for member-join notifications"
```

---

## Final verification

- [ ] **Full test suite:** `pnpm test` (or at least `pnpm --filter @uploads/auth test && pnpm --filter @uploads/email test && pnpm --filter @uploads/web test && pnpm --filter @uploads/api test`) — all green.
- [ ] **Typecheck all touched:** `pnpm --filter @uploads/auth types && pnpm --filter @uploads/email types && pnpm --filter @uploads/web types && pnpm --filter @uploads/api types`.
- [ ] **Lint/format:** repo pre-commit (oxfmt/prettier) already ran per-commit; confirm no residual diff.
- [ ] **Changeset:** add a changeset if the repo requires one for these packages (`@uploads/auth`, `@uploads/email`, `@uploads/web`, `@uploads/api`) — follow the repo's changeset convention.
- [ ] **Manual smoke:** operator `/admin/email` preview of `member-join-admin-notice` renders; a dev join (both paths) logs the expected recipients; the profile toggle round-trips.

---

## Self-review notes

- **Spec coverage:** storage (Task 1), helper (Task 3), template (Task 2), both join paths (Tasks 4–5), settings toggle (Task 6), error handling (helper try/catch + fire-and-forget, Task 3), testing (per-task). All spec sections map to a task.
- **Type consistency:** `notifyMemberJoin` (camel) / `notify_member_join` (DB) used consistently; helper name `notifyAdminsOfMemberJoin`, template id `member-join-admin-notice`, renderer `renderMemberJoinAdminNoticeEmail`, client helper `updateNotifyMemberJoin` — identical across tasks.
- **Known runtime check:** Task 5 Step 3 flags the one uncertainty (`org.slug` presence on the better-auth hook argument) with a concrete fallback.
