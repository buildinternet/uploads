/**
 * People section of the workspace drawer: members + pending invites (loaded
 * together), the org-invite form, and the enrollment invite-link generator
 * with per-link revoke. React port of the imperative page's `loadDetail`
 * members/invites block, `renderInviteLinks`, and the two form handlers.
 *
 * Members/invites and the org-invite form only exist for a workspace that has
 * an organization; the invite-link generator is workspace-level and always
 * shown. After a mutation each affected list is refetched (the React
 * equivalent of the imperative `loadOnce` reset), which sidesteps the
 * in-flight-reload race the imperative version had to track by hand.
 */
import { useState } from "react";
import { Button } from "@uploads/ui/components/ui/button";
import { formatDate } from "../../lib/subscription-copy";
import { errMessage, type AdminApi, type OpenEnrollment } from "../../lib/admin-api";
import { FIELD_LABEL, INPUT_TEXT, SELECT_SM } from "./field-classes";
import { Muted, SectionHeading, StatusLine } from "./StatusLine";
import { useAdminResource } from "./use-admin-resource";

const SCOPES = ["files:read", "files:write"] as const;

export function PeopleSection({
  api,
  workspace,
  hasOrg,
}: {
  api: AdminApi;
  workspace: string;
  hasOrg: boolean;
}) {
  // A successful invite bumps this nonce, which the members section takes as a
  // load dep and refetches — a plain parent-owned signal, no global events.
  const [membersReload, setMembersReload] = useState(0);
  return (
    <div className="grid gap-3.5">
      {hasOrg ? <MembersInvites api={api} workspace={workspace} reloadKey={membersReload} /> : null}
      {hasOrg ? (
        <InviteForm
          api={api}
          workspace={workspace}
          onInvited={() => setMembersReload((n) => n + 1)}
        />
      ) : (
        <Muted>No organization provisioned for this workspace yet — run the org backfill.</Muted>
      )}
      <InviteLinks api={api} workspace={workspace} />
    </div>
  );
}

function MembersInvites({
  api,
  workspace,
  reloadKey,
}: {
  api: AdminApi;
  workspace: string;
  reloadKey: number;
}) {
  const { data, error } = useAdminResource(
    () =>
      Promise.all([api.getMembers(workspace), api.getInvites(workspace)]).then(
        ([members, invites]) => ({ members, invites }),
      ),
    [api, workspace, reloadKey],
  );

  if (error) return <Muted>Failed to load members.</Muted>;
  if (!data) return <Muted>Loading members…</Muted>;

  const { members, invites } = data;
  return (
    <div className="grid gap-3.5">
      <div>
        <SectionHeading>Members</SectionHeading>
        {members.length ? (
          <ul className="grid list-none gap-1.5 p-0">
            {members.map((m) => (
              <li
                key={m.email}
                className="flex justify-between gap-2 text-(length:--text-micro) text-body"
              >
                <span>{m.email}</span>
                <span className="text-muted-foreground">{m.role}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Muted>No members yet.</Muted>
        )}
      </div>
      {invites.length > 0 && (
        <div>
          <SectionHeading>Pending invites</SectionHeading>
          <ul className="grid list-none gap-1.5 p-0">
            {invites.map((i) => (
              <li
                key={i.email}
                className="flex justify-between gap-2 text-(length:--text-micro) text-body"
              >
                <span>{i.email}</span>
                <span className="text-muted-foreground">pending</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function InviteForm({
  api,
  workspace,
  onInvited,
}: {
  api: AdminApi;
  workspace: string;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ state: "error" | "ok"; message: string } | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setStatus(null);
    setBusy(true);
    try {
      await api.createInvite(workspace, { email: email.trim(), role });
      setStatus({ state: "ok", message: `Invited ${email.trim()}.` });
      setEmail("");
      onInvited();
    } catch (err) {
      setStatus({ state: "error", message: errMessage(err, "Couldn't send the invite.") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className={FIELD_LABEL}>
          Email
          <input
            type="email"
            required
            className={`${INPUT_TEXT} min-w-[200px] flex-1`}
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className={FIELD_LABEL}>
          Role
          <select
            className={SELECT_SM}
            style={{ width: "auto" }}
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <Button type="submit" variant="outline" size="sm" disabled={busy}>
          Invite
        </Button>
      </div>
      {status && <StatusLine state={status.state}>{status.message}</StatusLine>}
    </form>
  );
}

function InviteLinks({ api, workspace }: { api: AdminApi; workspace: string }) {
  const {
    data: links,
    error: loadError,
    reload,
  } = useAdminResource<OpenEnrollment[]>(() => api.getInviteLinks(workspace), [api, workspace]);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<Record<string, boolean>>({
    "files:read": true,
    "files:write": true,
  });
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ state: "error" | "ok"; message: string } | null>(null);

  async function generate() {
    const chosen = SCOPES.filter((s) => scopes[s]);
    if (chosen.length === 0) {
      setStatus({ state: "error", message: "Pick at least one scope." });
      return;
    }
    setStatus(null);
    setGeneratedUrl(null);
    setBusy(true);
    try {
      const url = await api.createInviteLink(workspace, {
        label: label.trim() || undefined,
        scopes: chosen,
      });
      setGeneratedUrl(url);
      setLabel("");
      reload();
    } catch (err) {
      setStatus({ state: "error", message: errMessage(err, "Couldn't generate an invite link.") });
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!generatedUrl) return;
    try {
      await navigator.clipboard.writeText(generatedUrl);
      setStatus({ state: "ok", message: "Copied." });
    } catch {
      setStatus({ state: "error", message: "Clipboard unavailable; copy the link manually." });
    }
  }

  async function revoke(id: string) {
    try {
      await api.revokeInviteLink(workspace, id);
      reload();
    } catch (err) {
      setStatus({ state: "error", message: errMessage(err, "Couldn't revoke the link.") });
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className={FIELD_LABEL}>
          Label (optional)
          <input
            type="text"
            className={`${INPUT_TEXT} min-w-[160px] flex-1`}
            placeholder="e.g. contractor"
            maxLength={100}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <fieldset className="m-0 flex items-center gap-3 border-0 p-0 text-(length:--text-micro) text-body">
          <legend className="sr-only">Scopes</legend>
          {SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={scopes[s]}
                onChange={(e) => setScopes((prev) => ({ ...prev, [s]: e.target.checked }))}
              />{" "}
              {s}
            </label>
          ))}
        </fieldset>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={generate} disabled={busy}>
          Generate invite link
        </Button>
        {generatedUrl && (
          <>
            <input
              type="text"
              readOnly
              aria-label="Invite link"
              className="min-w-[200px] flex-1 rounded-sm border border-border bg-background px-[9px] py-[7px] font-mono text-(length:--text-micro) text-foreground"
              value={generatedUrl}
            />
            <Button type="button" variant="outline" size="sm" onClick={copy}>
              Copy
            </Button>
          </>
        )}
      </div>
      {status && <StatusLine state={status.state}>{status.message}</StatusLine>}
      {loadError ? (
        <Muted>Failed to load invite links.</Muted>
      ) : links && links.length > 0 ? (
        <div>
          <SectionHeading>Invite links</SectionHeading>
          <ul className="grid list-none gap-1.5 p-0">
            {links.map((link) => {
              const expiry = link.expiresAt
                ? `expires ${formatDate(link.expiresAt) ?? link.expiresAt}`
                : "never expires";
              const uses =
                link.kind === "member"
                  ? ` · ${link.useCount ?? 0}${link.maxUses ? `/${link.maxUses}` : ""} joins`
                  : "";
              const detail = link.kind === "member" ? "member" : link.scopes.join(", ");
              return (
                <li
                  key={link.id}
                  className="flex items-center justify-between gap-2 text-(length:--text-micro) text-body"
                >
                  <span>
                    {link.label ? (
                      link.label
                    ) : (
                      <span className="text-muted-foreground">unlabeled</span>
                    )}{" "}
                    · {detail} · {expiry}
                    {uses}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => revoke(link.id)}
                  >
                    Revoke
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
