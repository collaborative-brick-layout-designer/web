// Sharing a module or a custom part with people: its owners invite by
// email (the person gets a link to accept, like a layout invite), see who
// has it and the invites still waiting, cancel an invite or take someone
// off. Everyone else sees who has it, and can leave it themselves.

import { useState, type FormEvent } from 'react';
import { inviteExpiry } from '../ui/inviteExpiry';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CollaboratorSummary, type CustomPartSummary, type InviteSummary, type ModuleSummary, type SetPartSummary } from '../api';
import { HelpButton } from '../help/HelpButton';
import { useIsDemo } from '../catalog/ShareToCatalog';
import { askConfirm, confirmDelete } from '../ui/ConfirmDialog';
import { CopyLinkButton } from '../layouts/ShareDialog';
import { useEscape } from '../editor/useEscape';

type Role = 'owner' | 'editor' | 'viewer';

/** What the dialog shares, and the calls that share it. */
interface Shareable {
  /** "module" or "part": the words, and test ids (`module-people`). */
  noun: 'module' | 'part';
  /** Query keys: its share list, and the list it appears in. */
  listKey: string;
  thingsKey: string;
  collaborators: (id: string) => Promise<{ collaborators: CollaboratorSummary[]; invites?: InviteSummary[]; setParts?: SetPartSummary[] }>;
  invite: (id: string, email: string, role: 'viewer' | 'editor') => Promise<{ inviteUrl: string; emailDelivered: boolean; emailNote?: string }>;
  revokeInvite: (id: string, inviteId: string) => Promise<unknown>;
  removeCollaborator: (id: string, userId: string) => Promise<unknown>;
}

const MODULE: Shareable = {
  noun: 'module',
  listKey: 'module-collaborators',
  thingsKey: 'modules',
  collaborators: (id) => api.modules.collaborators(id),
  invite: (id, email, role) => api.modules.invite(id, email, role),
  revokeInvite: (id, inviteId) => api.modules.revokeInvite(id, inviteId),
  removeCollaborator: (id, userId) => api.modules.removeCollaborator(id, userId),
};

const PART: Shareable = {
  noun: 'part',
  listKey: 'custom-part-collaborators',
  thingsKey: 'custom-parts',
  collaborators: (id) => api.customParts.collaborators(id),
  invite: (id, email, role) => api.customParts.invite(id, email, role),
  revokeInvite: (id, inviteId) => api.customParts.revokeInvite(id, inviteId),
  removeCollaborator: (id, userId) => api.customParts.removeCollaborator(id, userId),
};

interface Props {
  module: Pick<ModuleSummary, 'id' | 'title' | 'role'>;
  myUserId: string | undefined;
  onClose: () => void;
}

export function ModuleShareDialog({ module, myUserId, onClose }: Props) {
  return <ShareWithPeopleDialog what={MODULE} id={module.id} title={module.title} role={module.role} myUserId={myUserId} onClose={onClose} />;
}

/** Share a custom part with people, by invite link like a module. */
export function PartShareDialog({
  part,
  myUserId,
  onClose,
}: {
  part: Pick<CustomPartSummary, 'id' | 'displayName' | 'partNumber' | 'role'>;
  myUserId: string | undefined;
  onClose: () => void;
}) {
  return <ShareWithPeopleDialog what={PART} id={part.id} title={part.displayName || part.partNumber} role={part.role} myUserId={myUserId} onClose={onClose} />;
}

function ShareWithPeopleDialog({
  what,
  id,
  title,
  role,
  myUserId,
  onClose,
}: {
  what: Shareable;
  id: string;
  title: string;
  role: Role | undefined;
  myUserId: string | undefined;
  onClose: () => void;
}) {
  useEscape(onClose);
  const qc = useQueryClient();
  const key = [what.listKey, id];
  const list = useQuery({ queryKey: key, queryFn: () => what.collaborators(id) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: [what.thingsKey] });
  };
  // One in your own list without a role is yours.
  const isOwner = role === undefined || role === 'owner';
  const demo = useIsDemo();
  const canShare = isOwner && !demo;
  const invites = list.data?.invites ?? [];
  const noun = what.noun;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-3 sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Share ${title}`}
        className="max-h-full w-full max-w-lg space-y-4 overflow-y-auto overscroll-contain rounded-lg border border-line bg-panel p-4 sm:p-6"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="break-words text-lg font-semibold">Share “{title}”</h3>
            <p className="text-xs text-muted">
              {demo
                ? `The demo account can’t invite people. Make your own account to share ${noun}s.`
                : isOwner
                  ? `Invite people by email. They get a link, and have the ${noun} once they accept.`
                  : `You can ${role === 'editor' ? 'edit' : 'look at'} this ${noun}. Only its owners change who has it.`}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 rounded-lg p-1 text-muted hover:bg-soft">
            ✕
          </button>
        </div>

        {list.data?.setParts && list.data.setParts.length > 0 && <ComesAlong parts={list.data.setParts} isOwner={isOwner} />}
        {canShare && <InviteForm what={what} id={id} onInvited={refresh} />}

        {list.isLoading && <p className="text-sm text-muted">Loading…</p>}
        {list.isError && <p className="text-sm text-danger">{(list.error as Error).message}</p>}
        {list.data && (
          <div className="space-y-3">
            <People what={what} id={id} people={list.data.collaborators} myUserId={myUserId} isOwner={isOwner} onChange={refresh} onLeft={onClose} />
            {invites.length > 0 && <PendingInvites what={what} id={id} invites={invites} isOwner={isOwner} onChange={refresh} />}
          </div>
        )}
      </div>
    </div>
  );
}

/** A set's own custom parts: they come along when it's shared, and go when it's taken back. */
function ComesAlong({ parts, isOwner }: { parts: SetPartSummary[]; isOwner: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-soft/40 p-3 text-sm" data-testid="set-parts-come-along">
      <p className="flex items-start gap-1">
        <span>
          {parts.length === 1 ? 'This custom part of yours comes along with the set:' : `These ${parts.length} custom parts of yours come along with the set:`}
        </span>
        <HelpButton helpKey="set.sharing" />
      </p>
      <ul className="mt-1 list-inside list-disc text-xs">
        {parts.map((p) => (
          <li key={p.id} className="break-words">
            {p.displayName && p.displayName !== p.partNumber ? `${p.displayName} (${p.partNumber})` : p.partNumber}
          </li>
        ))}
      </ul>
      {isOwner && (
        <p className="mt-1 text-xs text-muted">
          People you share it with can look at and place them. Taking the set back takes them back too, unless you shared them on their own.
        </p>
      )}
    </div>
  );
}

function InviteForm({ what, id, onInvited }: { what: Shareable; id: string; onInvited: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'viewer' | 'editor'>('viewer');
  const [sent, setSent] = useState<{ url: string; delivered: boolean; note?: string | undefined; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () => what.invite(id, email, role),
    onSuccess: (res) => {
      setSent({ url: res.inviteUrl, delivered: res.emailDelivered, note: res.emailNote, to: email });
      setEmail('');
      onInvited();
    },
    onError: (e: Error) => setError(e.message),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSent(null);
    invite.mutate();
  }
  return (
    <form onSubmit={submit} className="rounded-lg border border-line p-3 text-sm" aria-label="Invite someone">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[12rem] flex-1">
          <span className="mb-1 block text-xs text-muted">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-border bg-soft px-2 py-1.5"
            placeholder="alice@example.com"
          />
        </label>
        <label>
          <span className="mb-1 block text-xs text-muted">Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as 'viewer' | 'editor')}
            className="rounded-lg border border-border bg-soft px-2 py-1.5"
          >
            <option value="viewer">Viewer (can use it)</option>
            <option value="editor">Editor (can change it)</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={invite.isPending}
          className="rounded-lg bg-accent px-3 py-1.5 text-sm text-accent-ink hover:bg-accent-hover disabled:opacity-50"
        >
          Invite
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      {sent && (
        <div role="status" className="mt-3 rounded-lg border border-emerald-900 bg-emerald-950/30 p-2 text-xs">
          <p className="text-emerald-400">
            {sent.delivered
              ? `Invite sent to ${sent.to}.`
              : sent.note
                ? `Invite made for ${sent.to}. ${sent.note}`
                : `Invite made for ${sent.to}. This site can’t send email, so send them the link yourself.`}
          </p>
          <p className="mt-1 text-neutral-300">They open the link and sign in with that address to accept:</p>
          <code className="mt-1 block break-all rounded-lg bg-bg p-1 text-[11px]">{sent.url}</code>
          <CopyLinkButton url={sent.url} />
        </div>
      )}
    </form>
  );
}

function People({
  what,
  id,
  people,
  myUserId,
  isOwner,
  onChange,
  onLeft,
}: {
  what: Shareable;
  id: string;
  people: CollaboratorSummary[];
  myUserId: string | undefined;
  isOwner: boolean;
  onChange: () => void;
  onLeft: () => void;
}) {
  const remove = useMutation({
    mutationFn: (userId: string) => what.removeCollaborator(id, userId),
    onSuccess: (_r, userId) => {
      onChange();
      if (userId === myUserId) onLeft();
    },
  });
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">People with access</h4>
      <ul className="divide-y divide-line rounded-lg border border-line" data-testid={`${what.noun}-people`}>
        {people.length === 0 && <li className="px-3 py-2 text-xs text-muted">Not shared with anyone yet.</li>}
        {people.map((p) => {
          const isSelf = p.userId === myUserId;
          return (
            <li key={p.userId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="break-words">
                  {p.displayName} {isSelf && <span className="text-xs text-muted">(you)</span>}
                </p>
                {p.email && <p className="break-all text-xs text-muted">{p.email}</p>}
                {p.viaSets && p.viaSets.length > 0 && (
                  <p className="text-xs text-muted">
                    With the set{p.viaSets.length === 1 ? '' : 's'} {p.viaSets.map((n) => `“${n}”`).join(', ')}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-lg bg-soft px-2 py-1 text-xs text-neutral-300">{p.role}</span>
                {(isOwner || isSelf) && p.role !== 'owner' && (
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = isSelf
                        ? await askConfirm({
                            title: `Leave this ${what.noun}?`,
                            removes: 'You lose access to it and it leaves your list.',
                            keeps: `The ${what.noun} itself doesn’t change. Its owner can invite you again.`,
                            confirmLabel: 'Leave',
                          })
                        : await confirmDelete(p.displayName, {
                            verb: 'Remove',
                            removes: `${p.displayName} can’t ${what.noun === 'part' ? 'use this part' : 'open this module'} any more.`,
                            keeps: `The ${what.noun} doesn’t change. You can invite them again.`,
                          });
                      if (ok) remove.mutate(p.userId);
                    }}
                    className="rounded-lg border border-red-900 px-2 py-1 text-xs text-danger hover:bg-red-950"
                  >
                    {isSelf ? 'Leave' : 'Remove'}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PendingInvites({ what, id, invites, isOwner, onChange }: { what: Shareable; id: string; invites: InviteSummary[]; isOwner: boolean; onChange: () => void }) {
  const revoke = useMutation({ mutationFn: (inviteId: string) => what.revokeInvite(id, inviteId), onSuccess: onChange });
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Pending invites</h4>
        <HelpButton helpKey="share.pending" />
      </div>
      <ul className="divide-y divide-line rounded-lg border border-line" data-testid={`${what.noun}-invites`}>
        {invites.map((i) => (
          <li key={i.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
            <div className="min-w-0">
              <p className="break-all">{i.invitedEmail}</p>
              <p className="text-xs text-muted">
                {i.role} · {inviteExpiry(i.expiresAt)}
              </p>
            </div>
            {isOwner && (
              <button
                type="button"
                onClick={async () => {
                  const ok = await confirmDelete(i.invitedEmail, {
                    title: `Cancel the invite for ${i.invitedEmail}?`,
                    verb: 'Cancel',
                    confirmLabel: 'Cancel invite',
                    removes: 'The invite link stops working.',
                    keeps: 'You can invite them again.',
                  });
                  if (ok) revoke.mutate(i.id);
                }}
                className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-soft"
              >
                Cancel invite
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
