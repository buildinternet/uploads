# Invite-acceptance admin notification — design

**Date:** 2026-08-29
**Branch:** `claude/invite-acceptance-notifications-231346`
**Status:** Approved design, pre-implementation

## Summary

When a user joins a workspace, notify that workspace's admins/owners by
email. Each user can turn this notification off in their account settings.
The notification is **on by default**.

A sibling feature — usage-limit alert emails at 50/90/100% — is explicitly
**out of scope** and ships as a separate follow-up PR. See "Follow-up" below.

## Requirements

- A new member joining a workspace triggers an email to that workspace's
  admins and owners.
- Fires for **both** join paths: better-auth email invites AND
  join-links / enrollment codes.
- Recipients: every member with role `admin` or `owner`, **excluding the
  person who just joined**. On the email-invite path, also exclude the
  inviter (they already receive the tailored `member-joined` email).
- Each user has a per-account toggle "Email me when someone joins a
  workspace I administer", **default on**.
- Mail is fire-and-forget: a mail failure must never roll back or fail the
  join.

## Non-goals

- Usage-limit alert emails (separate follow-up PR).
- Per-workspace notification preferences (this is a per-user preference).
- Notifying plain members (`role = member`) — admins/owners only.
- In-app / push notifications — email only.

## Architecture

Storage, join logic, and member/user data all live in the **AUTH worker**
(`apps/auth`), so the entire feature is implemented there plus the shared
email package and the web settings surface. No cross-worker preference
plumbing.

### 1. Preference storage (D1, `user` table)

Add one boolean column to the `user` table in
`apps/auth/src/schema.ts:36`:

```ts
notifyMemberJoin: integer("notify_member_join", { mode: "boolean" })
  .notNull()
  .$defaultFn(() => true),
```

Paired migration in `apps/auth/migrations/` (D1 migrations auto-apply on
merge to prod):

```sql
ALTER TABLE user ADD COLUMN notify_member_join INTEGER NOT NULL DEFAULT 1;
```

A single typed column (not a JSON blob, not a new table) — queryable and
minimal. The follow-up usage-alert PR adds its own column the same way;
each PR stays self-contained.

### 2. Notification helper (AUTH worker)

New module `apps/auth/src/notify-member-join.ts`:

```ts
notifyAdminsOfMemberJoin(env, db, {
  organizationId: string,
  organizationName: string,
  joinerUserId: string,
  joinerEmail: string,
  excludeUserIds?: string[],   // inviter on the email-invite path
}): Promise<void>
```

- One query: `member ⋈ user` where
  `member.organizationId = organizationId`,
  `member.role IN ('admin','owner')`,
  `user.notifyMemberJoin = true`,
  `user.id NOT IN (joinerUserId, ...excludeUserIds)`.
- For each recipient, `await sendAuthEmail(env, { to, template:
"member-join-admin-notice", context })`. `sendAuthEmail` never throws, so
  the whole helper is safe to `await` inside a join without a rollback risk.
- Wrap the query in try/catch and log-only, so even a DB read failure can't
  fail the join.

### 3. Email template (`@uploads/email`)

New `renderMemberJoinAdminNoticeEmail(input)` in
`packages/email/src/invites.ts`, mirroring `renderMemberJoinedEmail`
(`invites.ts:88`) and built on `renderEmailCard` (`card.ts:146`):

- Subject: `New member joined <workspace>`
- Body: `<joiner email> joined <workspace name>.`
- CTA: manage-members link → `<webOrigin>/account/workspaces/<slug>/settings`
  (members tab).
- Footnote: "You're receiving this because you administer this workspace.
  Manage notifications in your account settings." linking to
  `<webOrigin>/account/profile`.

Wire it into the dispatcher:

- `apps/auth/src/email.ts` — add the `"member-join-admin-notice"` arm to the
  `SendAuthEmailArgs` union (line 33) and the `render()` switch (line 51),
  and import the new renderer.
- `apps/api/src/admin-email-preview.ts` — register the new type in
  `EMAIL_PREVIEW_TYPES` and `renderPreview` so operators can preview /
  self-send it via `/admin/email`.
- `packages/email/src/index.ts` — export the new renderer.

### 4. Wiring the two join paths

**Join-links / enrollment codes** —
`apps/auth/src/internal-routes.ts` `/internal/join`, the fresh-insert
branch at line 1005 (`insert.meta.changes === 1`, returns 201). Before
returning, call `notifyAdminsOfMemberJoin` with `joinerUserId = userId`,
`joinerEmail = user.email`, no extra exclusions. `org`, `user`, and `db`
are already in scope. This path emails nobody today.

**Email invites** — `apps/auth/src/auth.ts` `afterAcceptInvitation`
(line 634). After the existing inviter `member-joined` email (641-647) and
the welcome email, call `notifyAdminsOfMemberJoin` with
`joinerUserId = user.id`, `joinerEmail = user.email`, and
`excludeUserIds = invitation.inviterId ? [invitation.inviterId] : []`. The
existing inviter email stays untouched — it's a different, inviter-specific
message; excluding the inviter from the admin-notice avoids double-emailing
them.

### 5. Settings toggle (web, SSR-first, no framework JS)

- **UI:** add an "Email notifications" `.settings-section` to
  `apps/web/src/pages/account/profile.astro` with a single checkbox
  ("Email me when someone joins a workspace I administer"), reflecting the
  user's current `notifyMemberJoin`. Progressive-enhancement form (checkbox
  - Save button) — no React (signed-in account pages are Astro/SSR).
- **Same-origin proxy:** new route
  `apps/web/src/pages/api/account/notification-prefs.ts` (POST), mirroring
  the `apps/web/src/pages/api/enrollments/join.ts` proxy pattern. Reads the
  session, forwards to the AUTH internal route.
- **AUTH write route:** new `POST /internal/user/notification-prefs` in
  `apps/auth/src/internal-routes.ts`, session/user-guarded, updates
  `user.notifyMemberJoin` for the authenticated user only. Body:
  `{ notifyMemberJoin: boolean }`.
- The current session-user shape (`SessionUser`,
  `apps/web/src/lib/auth-client.ts:47`) gains `notifyMemberJoin` so the
  page can render the current state; confirm better-auth surfaces the new
  column on the session (it selects `user.*`), otherwise fetch it in the
  page loader.

## Data flow

```
join (invite accept OR join-link redeem)
  └─ membership row inserted (existing code)
       └─ notifyAdminsOfMemberJoin(env, db, {...})
            ├─ SELECT admins/owners with notifyMemberJoin=true, minus joiner (+inviter)
            └─ for each: sendAuthEmail("member-join-admin-notice")   [never throws]

settings toggle
  profile.astro form → POST /api/account/notification-prefs (web, session)
    → POST /internal/user/notification-prefs (auth, session-guarded)
      → UPDATE user SET notify_member_join = ? WHERE id = <session user>
```

## Error handling

- All mail is fire-and-forget via `sendAuthEmail` (logs, never throws).
- `notifyAdminsOfMemberJoin` wraps its DB read in try/catch and log-only;
  a failure there must not affect the join response.
- The prefs write route returns 401 when unauthenticated, 400 on a
  malformed body, 200 on success.

## Testing (plain vitest + in-process fakes)

- `notifyAdminsOfMemberJoin`: emails admins and owners; skips plain
  members; excludes the joiner; excludes extra `excludeUserIds` (inviter);
  respects `notifyMemberJoin = false`; sends nothing when no eligible
  recipients; a thrown DB error is swallowed (no throw).
- Both call sites: join-link fresh insert triggers the helper with the
  joiner excluded; invite-accept triggers it with joiner + inviter
  excluded; an `alreadyMember` result triggers nothing.
- Email template: renders subject/body/CTA/footnote for representative
  input (smoke).
- Prefs write route: persists the new value for the session user; rejects
  unauthenticated; ignores/400s a malformed body; a user can only change
  their own row.
- Migration: column exists with default 1; existing rows read as `true`.

## Follow-up (separate PR, not this one)

Usage-limit alert emails at 50%, 90%, and 100% of a workspace's usage
limit. This is a distinct notification category with its own
threshold-crossing detection, de-duplication (fire once per threshold, not
per upload), billing-period reset, and its own per-user toggle column.
Design and implementation land in a separate PR; the usage-infrastructure
exploration notes are captured for that effort.
