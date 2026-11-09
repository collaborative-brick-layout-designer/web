import { useState, type FormEvent } from 'react';
import { inviteExpiry } from '../ui/inviteExpiry';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CollaboratorSummary, type InviteSummary } from '../api';
import { clubsICanAddTo } from '../owners/OwnerControls';
import { HelpButton } from '../help/HelpButton';
import { CatalogBadge, useCatalogStatus, useIsDemo } from '../catalog/ShareToCatalog';
import { askConfirm, confirmDelete, showToast } from '../ui/ConfirmDialog';
import { useEscape } from '../editor/useEscape';

interface Props {
  layoutId: string;
  layoutTitle: string;
  /** Caller's role on this layout — gates owner-only controls. */
  myRole: 'owner' | 'editor' | 'viewer';
  /** Caller's user id — used to mark "you" in the list. */
  myUserId: string;
  onClose: () => void;
  /** The editor's "Share a picture" (pictures need the open map). */
  onSharePicture?: () => void;
  /** The editor's "Share to the public catalog" (its picture needs the open map). */
  onShareToCatalog?: () => void;
}

/**
 * Modal sharing dialog. Owner sees the full UI: invite, role-change,
 * remove. Editors and viewers see a read-only collaborator list (so they
 * know who else has access). The dialog is mounted by `LayoutsPage` and
 * by the editor's header — same component, same shape.
 */
export function ShareDialog({
  layoutId,
  layoutTitle,
  myRole,
  myUserId,
  onClose,
  onSharePicture,
  onShareToCatalog,
}: Props) {
  useEscape(onClose);
  const catalog = useCatalogStatus();
  const shared = catalog.shared('layout', layoutId);
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['collaborators', layoutId],
    queryFn: () => api.collaborators.list(layoutId),
  });

  const isOwner = myRole === 'owner';
  // The shared demo account can't invite, hand over or make a link (the
  // server says no): it gets a picture to share, and a word on why.
  const demo = useIsDemo();
  const canShare = isOwner && !demo;

  return (
    <div className="fixed inset-0 grid place-items-center bg-black/60 p-3 sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Share ${layoutTitle}`}
        // On a phone it fills the width and scrolls inside itself.
        className="max-h-full w-full max-w-lg space-y-4 overflow-y-auto overscroll-contain rounded-lg border border-line bg-panel p-4 sm:p-6"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="break-words text-lg font-semibold">Share "{layoutTitle}"</h3>
            <p className="text-xs text-muted">
              {demo
                ? 'The demo account can’t invite people or make a share link. Make your own account to share layouts.'
                : isOwner
                ? 'Invite people by email or manage existing access.'
                : `You have ${myRole} access. Only the owner can change sharing.`}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 rounded-lg p-1 text-muted hover:bg-soft"
          >
            ✕
          </button>
        </div>

        {onSharePicture && (
          <button
            type="button"
            onClick={onSharePicture}
            className="flex min-h-11 w-full items-center gap-3 rounded-lg border border-line px-3 py-2 text-left hover:bg-soft"
          >
            <span className="font-semibold">Share a picture</span>
            <span className="text-xs text-muted">Send a picture of the layout to anyone, no account needed</span>
          </button>
        )}

        {isOwner && onShareToCatalog && catalog.enabled('layout') && (
          <button
            type="button"
            onClick={onShareToCatalog}
            className="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line px-3 py-2 text-left hover:bg-soft"
          >
            <span className="font-semibold">{shared ? 'Publish a new version to the catalog' : 'Share to the public catalog'}</span>
            <span className="text-xs text-muted">Everyone can look at a copy of it and copy it; this layout stays private</span>
            {shared && <CatalogBadge item={shared} />}
          </button>
        )}

        {canShare && (
          <InviteForm
            layoutId={layoutId}
            onInvited={() => qc.invalidateQueries({ queryKey: ['collaborators', layoutId] })}
          />
        )}

        {canShare && <TransferSection layoutId={layoutId} />}

        {canShare && <PublicShareSection layoutId={layoutId} />}

        <AuditPanel layoutId={layoutId} />

        {list.isLoading && <p className="text-sm text-muted">Loading…</p>}
        {list.data && (
          <div className="space-y-3">
            <CollaboratorList
              layoutId={layoutId}
              myUserId={myUserId}
              isOwner={isOwner}
              collaborators={list.data.collaborators}
              onChange={() =>
                qc.invalidateQueries({ queryKey: ['collaborators', layoutId] })
              }
            />
            {list.data.invites.length > 0 && (
              <PendingInvites
                layoutId={layoutId}
                invites={list.data.invites}
                isOwner={isOwner}
                onChange={() =>
                  qc.invalidateQueries({ queryKey: ['collaborators', layoutId] })
                }
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function InviteForm({
  layoutId,
  onInvited,
}: {
  layoutId: string;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'viewer' | 'editor'>('editor');
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [delivered, setDelivered] = useState(false);
  const [emailNote, setEmailNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invite = useMutation({
    mutationFn: () => api.collaborators.invite(layoutId, email, role),
    onSuccess: (res) => {
      setShareUrl(res.inviteUrl);
      setDelivered(res.emailDelivered);
      setEmailNote(res.emailNote ?? null);
      setEmail('');
      onInvited();
    },
    onError: (e: Error) => setError(e.message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setShareUrl(null);
    invite.mutate();
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-line p-3 text-sm">
      {/* Email gets its own row on a phone; role and Invite share the next. */}
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
        <div>
          <span className="mb-1 flex items-center gap-1.5 text-xs text-muted">
            <label htmlFor="share-invite-role">Role</label>
            <HelpButton helpKey="share.roles" target="#share-invite-role" />
          </span>
          <select
            id="share-invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as 'viewer' | 'editor')}
            className="rounded-lg border border-border bg-soft px-2 py-1.5"
          >
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={invite.isPending}
          className="rounded-lg bg-accent text-accent-ink px-3 py-1.5 text-sm hover:bg-accent-hover disabled:opacity-50"
        >
          Invite
        </button>
      </div>

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {shareUrl && (
        <div className="mt-3 rounded-lg border border-emerald-900 bg-emerald-950/30 p-2 text-xs">
          <p className="text-emerald-400">
            {delivered ? 'Email sent.' : (emailNote ?? 'Email delivery skipped (no SMTP configured).')}
          </p>
          <p className="mt-1 text-neutral-300">
            Share this link with the recipient (the email-match check
            still applies on accept):
          </p>
          <code
            className="mt-1 block break-all rounded-lg bg-bg p-1 text-[11px]"
          >
            {shareUrl}
          </code>
          <CopyLinkButton url={shareUrl} />
        </div>
      )}
    </form>
  );
}

function CollaboratorList({
  layoutId,
  myUserId,
  isOwner,
  collaborators,
  onChange,
}: {
  layoutId: string;
  myUserId: string;
  isOwner: boolean;
  collaborators: CollaboratorSummary[];
  onChange: () => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Collaborators
        </h4>
        <HelpButton helpKey="share.people" />
      </div>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {collaborators.length === 0 && (
          <li className="px-3 py-2 text-xs text-muted">No collaborators yet.</li>
        )}
        {collaborators.map((c) => (
          <CollaboratorRow
            key={c.userId}
            layoutId={layoutId}
            collaborator={c}
            isSelf={c.userId === myUserId}
            isOwner={isOwner}
            onChange={onChange}
          />
        ))}
      </ul>
    </div>
  );
}

function CollaboratorRow({
  layoutId,
  collaborator,
  isSelf,
  isOwner,
  onChange,
}: {
  layoutId: string;
  collaborator: CollaboratorSummary;
  isSelf: boolean;
  isOwner: boolean;
  onChange: () => void;
}) {
  const change = useMutation({
    mutationFn: (role: 'viewer' | 'editor') =>
      api.collaborators.changeRole(layoutId, collaborator.userId, role),
    onSuccess: onChange,
  });
  const remove = useMutation({
    mutationFn: () => api.collaborators.remove(layoutId, collaborator.userId),
    onSuccess: onChange,
  });

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
      <div className="min-w-0">
        <p className="break-words">
          {collaborator.displayName}{' '}
          {isSelf && <span className="text-xs text-muted">(you)</span>}
        </p>
        {/* Only the person, the owners and site admins get the address (the server leaves it empty for others). */}
        {collaborator.email && <p className="break-all text-xs text-muted">{collaborator.email}</p>}
      </div>
      <div className="flex items-center gap-2">
        {isOwner && collaborator.role !== 'owner' ? (
          <select
            value={collaborator.role}
            onChange={(e) => change.mutate(e.target.value as 'viewer' | 'editor')}
            className="rounded-lg border border-border bg-soft px-2 py-1 text-xs"
          >
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </select>
        ) : (
          <span className="rounded-lg bg-soft px-2 py-1 text-xs text-neutral-300">
            {collaborator.role}
          </span>
        )}
        {(isOwner || isSelf) && collaborator.role !== 'owner' && (
          <button
            onClick={async () => {
              const ok = isSelf
                ? await askConfirm({
                    title: 'Leave this layout?',
                    removes: 'You lose access to it and it leaves your list.',
                    keeps: 'The layout itself doesn’t change. The owner can invite you again.',
                    confirmLabel: 'Leave',
                  })
                : await confirmDelete(collaborator.displayName, {
                    verb: 'Remove',
                    removes: `${collaborator.displayName} can’t open this layout any more.`,
                    keeps: 'The layout doesn’t change. You can invite them again.',
                  });
              if (ok) remove.mutate();
            }}
            className="rounded-lg border border-red-900 px-2 py-1 text-xs text-danger hover:bg-red-950"
          >
            {isSelf ? 'Leave' : 'Remove'}
          </button>
        )}
      </div>
    </li>
  );
}

function PendingInvites({
  layoutId,
  invites,
  isOwner,
  onChange,
}: {
  layoutId: string;
  invites: InviteSummary[];
  isOwner: boolean;
  onChange: () => void;
}) {
  const revoke = useMutation({
    mutationFn: (inviteId: string) => api.collaborators.revokeInvite(layoutId, inviteId),
    onSuccess: onChange,
  });
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Pending invites
        </h4>
        <HelpButton helpKey="share.pending" />
      </div>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {invites.map((i) => (
          <li key={i.id} className="flex items-center justify-between px-3 py-2 text-sm">
            <div>
              <p>{i.invitedEmail}</p>
              <p className="text-xs text-muted">
                {i.role} · {inviteExpiry(i.expiresAt)}
              </p>
            </div>
            {isOwner && (
              <button
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
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TransferSection({ layoutId }: { layoutId: string }) {
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: api.orgs.list });
  const [mode, setMode] = useState<'closed' | 'user' | 'org'>('closed');
  const [email, setEmail] = useState('');
  const [orgSlug, setOrgSlug] = useState('');
  const [linkResult, setLinkResult] = useState<{ id: string; url: string; emailDelivered: boolean; emailNote?: string | undefined } | null>(
    null,
  );
  const [orgResult, setOrgResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cancelTransfer = useMutation({
    mutationFn: (id: string) => api.transfers.cancel(layoutId, id),
    onSuccess: () => {
      setLinkResult(null);
      showToast('Transfer cancelled');
    },
    onError: (e: Error) => setError(e.message),
  });

  const initiate = useMutation({
    mutationFn: () =>
      mode === 'user'
        ? api.transfers.initiate(layoutId, { email })
        : api.transfers.initiate(layoutId, { orgSlug }),
    onSuccess: (res) => {
      setError(null);
      if ('transferred' in res) {
        setOrgResult(res.ownerSlug);
        setLinkResult(null);
      } else {
        setLinkResult({ id: res.id, url: res.transferUrl, emailDelivered: res.emailDelivered, emailNote: res.emailNote });
        setOrgResult(null);
      }
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="rounded-lg border border-line p-3 text-sm">
      <div className="mb-2 flex items-center gap-1.5">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Transfer ownership
        </h4>
        <HelpButton helpKey="share.transfer" />
      </div>
      {mode === 'closed' && (
        <div className="flex gap-2">
          <button
            onClick={() => setMode('user')}
            className="rounded-lg border border-border px-3 py-1 text-xs hover:bg-soft"
          >
            Transfer to a user
          </button>
          {orgs.data && orgs.data.orgs.length > 0 && (
            <button
              onClick={() => setMode('org')}
              className="rounded-lg border border-border px-3 py-1 text-xs hover:bg-soft"
            >
              Transfer to a club
            </button>
          )}
        </div>
      )}

      {mode === 'user' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            initiate.mutate();
          }}
          className="space-y-2"
        >
          <p className="text-xs text-muted">
            The recipient must accept via the link before ownership flips. You'll
            stay on the layout as an editor.
          </p>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="recipient@example.com"
            className="w-full rounded-lg border border-border bg-soft px-2 py-1.5"
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={initiate.isPending}
              className="rounded-lg bg-accent text-accent-ink px-3 py-1.5 text-xs hover:bg-accent-hover disabled:opacity-50"
            >
              Initiate transfer
            </button>
            <button
              type="button"
              onClick={() => setMode('closed')}
              className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-soft"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode === 'org' && orgs.data && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            initiate.mutate();
          }}
          className="space-y-2"
        >
          <p className="text-xs text-muted">
            It moves to the club at once. Afterwards, what you can do with it
            depends on your roles in that club.
          </p>
          <select
            value={orgSlug}
            onChange={(e) => setOrgSlug(e.target.value)}
            required
            className="w-full rounded-lg border border-border bg-soft px-2 py-1.5"
          >
            <option value="">Choose a club…</option>
            {clubsICanAddTo(orgs.data.orgs).map((o) => (
              <option key={o.slug} value={o.slug}>
                {o.name}
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={initiate.isPending || !orgSlug}
              className="rounded-lg bg-accent text-accent-ink px-3 py-1.5 text-xs hover:bg-accent-hover disabled:opacity-50"
            >
              Transfer to club
            </button>
            <button
              type="button"
              onClick={() => setMode('closed')}
              className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-soft"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {linkResult && (
        <div className="mt-3 rounded-lg border border-emerald-900 bg-emerald-950/30 p-2 text-xs">
          <p className="text-emerald-400">
            {linkResult.emailDelivered
              ? 'Email sent. The transfer is pending until the recipient accepts.'
              : linkResult.emailNote
                ? `${linkResult.emailNote} The transfer is pending until they accept.`
                : 'Email delivery skipped (no SMTP configured). Share this link:'}
          </p>
          <code className="mt-1 block break-all rounded-lg bg-bg p-1 text-[11px]">
            {linkResult.url}
          </code>
          <CopyLinkButton url={linkResult.url} />
          <button
            type="button"
            disabled={cancelTransfer.isPending}
            onClick={async () => {
              const ok = await askConfirm({
                title: 'Cancel this transfer?',
                removes: 'The transfer link stops working.',
                keeps: 'The layout stays yours. You can start a new transfer.',
                confirmLabel: 'Cancel transfer',
              });
              if (ok) cancelTransfer.mutate(linkResult.id);
            }}
            className="ml-3 mt-1 text-xs text-danger hover:underline disabled:opacity-50"
          >
            Cancel transfer
          </button>
        </div>
      )}

      {orgResult && (
        <div className="mt-3 rounded-lg border border-emerald-900 bg-emerald-950/30 p-2 text-xs text-emerald-400">
          Layout transferred to <strong>/{orgResult}</strong>.
        </div>
      )}
    </div>
  );
}

/** Per-layout audit log panel — collapsed by default. */
export function AuditPanel({ layoutId }: { layoutId: string }) {
  const events = useQuery({
    queryKey: ['audit', 'layout', layoutId],
    queryFn: () => api.audit.forLayout(layoutId),
    // Audit log isn't reactive — re-fetch on dialog open is enough.
    staleTime: 30_000,
  });

  // The ⓘ sits beside the summary, not in it: a button inside the summary
  // (itself a button) is lost to screen readers and the keyboard.
  return (
    <div className="relative">
    <details className="rounded-lg border border-line p-3 text-sm">
      <summary className="cursor-pointer pr-8 text-xs font-semibold uppercase tracking-wide text-muted">
        History
      </summary>
      <div className="mt-2 max-h-60 overflow-y-auto">
        {events.isLoading && <p className="text-xs text-muted">Loading…</p>}
        {events.data && events.data.events.length === 0 && (
          <p className="text-xs text-muted">No events recorded yet.</p>
        )}
        {events.data && events.data.events.length > 0 && (
          <ul className="space-y-1 text-xs">
            {events.data.events.map((e) => (
              <li
                key={e.id}
                className="grid grid-cols-[auto_1fr] gap-x-2 text-neutral-300"
              >
                <span className="font-mono text-muted">
                  {new Date(e.createdAt).toLocaleString()}
                </span>
                <span>
                  <strong>{e.eventType}</strong>
                  <span className="ml-1 text-muted">
                    {summarisePayload(e.payload)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
    <HelpButton helpKey="share.history" className="absolute right-3 top-3" />
    </div>
  );
}

/**
 * Public-share toggle. Owner-only. When enabled, anyone with the
 * `/p/<token>` URL can view the layout read-only without signing in.
 * Disable rotates the link (re-enabling mints a fresh token).
 */
function PublicShareSection({ layoutId }: { layoutId: string }) {
  const qc = useQueryClient();
  // Pull the latest token from the layout summary cached by editor /
  // layouts list. We refetch this layout's row directly so the dialog
  // always shows the current state regardless of which page mounted it.
  const layout = useQuery({
    queryKey: ['layout', layoutId],
    queryFn: () => api.layouts.get(layoutId),
  });

  const enable = useMutation({
    mutationFn: () => api.layouts.enablePublicShare(layoutId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['layout', layoutId] });
      qc.invalidateQueries({ queryKey: ['layouts'] });
    },
  });
  const disable = useMutation({
    mutationFn: () => api.layouts.disablePublicShare(layoutId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['layout', layoutId] });
      qc.invalidateQueries({ queryKey: ['layouts'] });
    },
  });

  const token = layout.data?.layout.publicShareToken ?? null;
  const url = token ? `${window.location.origin}/p/${token}` : null;

  return (
    <div className="rounded-lg border border-line p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Public link
            </h4>
            <HelpButton helpKey="share.publicLink" />
          </div>
          <p className="mt-1 text-xs text-muted">
            {token
              ? 'Anyone with this link can view (read-only) without signing in.'
              : 'Off — only invited collaborators can see this layout.'}
          </p>
        </div>
        {token ? (
          <button
            onClick={async () => {
              const ok = await askConfirm({
                title: 'Turn off the public link?',
                removes: 'The current link stops working for everyone who has it.',
                keeps: 'The layout and its collaborators don’t change.',
                undo: 'Turning it on again makes a new link.',
                confirmLabel: 'Turn off',
              });
              if (ok) disable.mutate();
            }}
            disabled={disable.isPending}
            className="rounded-lg border border-red-900 px-2 py-1 text-xs text-danger hover:bg-red-950 disabled:opacity-50"
          >
            Disable
          </button>
        ) : (
          <button
            onClick={() => enable.mutate()}
            disabled={enable.isPending}
            className="rounded-lg bg-accent text-accent-ink px-3 py-1 text-xs hover:bg-accent-hover disabled:opacity-50"
          >
            Enable
          </button>
        )}
      </div>
      {url && (
        <div className="mt-2">
          <code className="block break-all rounded-lg bg-bg p-1 text-[11px]">
            {url}
          </code>
          <CopyLinkButton url={url} />
        </div>
      )}
    </div>
  );
}

/**
 * Copy a link, saying whether it worked. The clipboard can refuse (no
 * permission, or a server reached over plain http, where there is no
 * clipboard at all); the link stays on screen to copy by hand.
 */
export function CopyLinkButton({ url }: { url: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(url);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2500);
  };
  return (
    <button type="button" onClick={() => void copy()} className="mt-1 text-xs text-accent-text hover:underline">
      {state === 'copied' ? 'Copied!' : state === 'failed' ? 'Could not copy; select the link and copy it.' : 'Copy link'}
    </button>
  );
}

function summarisePayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  // Cheap human-readable rendering. Full payload is in the response if
  // a power user wants the JSON; the UI is intentionally summary-only.
  const p = payload as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof p.invitedEmail === 'string') parts.push(`→ ${p.invitedEmail}`);
  if (typeof p.role === 'string') parts.push(`(${p.role})`);
  if (typeof p.toRole === 'string' && typeof p.fromRole === 'string') {
    parts.push(`${p.fromRole} → ${p.toRole}`);
  }
  if (p.to && typeof p.to === 'object') {
    const to = p.to as Record<string, unknown>;
    if (to.kind === 'org' && typeof to.slug === 'string') parts.push(`→ /${to.slug}`);
  }
  if (typeof p.partNumber === 'string') parts.push(`[${p.partNumber}]`);
  return parts.join(' ');
}
