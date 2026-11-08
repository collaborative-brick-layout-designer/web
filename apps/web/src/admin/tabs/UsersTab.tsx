// Admin › Users: everyone, a page at a time; admin and moderator switches,
// sign out everywhere, erase; one person's detail (also opened from Heavy use).

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatBytes } from '../insights/format';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { SubjectLimitsPanel } from '../limits/LimitsUi';
import { SubjectWarnings } from '../SubjectWarnings';
import { askConfirm, confirmDelete, toastDeleted } from '../../ui/ConfirmDialog';
import { Loading, Td, Th, Toolbar } from './shared';

export function UsersTab({ selfId }: { selfId: string }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const limit = 50;
  const list = useQuery({
    queryKey: ['admin-users', q, offset, limit],
    queryFn: () => api.admin.users({ q, offset, limit }),
  });

  const patchAdmin = useMutation({
    mutationFn: ({ id, isGlobalAdmin }: { id: string; isGlobalAdmin: boolean }) =>
      api.admin.patchUser(id, { isGlobalAdmin }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
  const patchModerator = useMutation({
    mutationFn: ({ id, isModerator }: { id: string; isModerator: boolean }) =>
      api.admin.patchUser(id, { isModerator }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });
  const revokeSessions = useMutation({
    mutationFn: (id: string) => api.admin.revokeUserSessions(id),
  });
  const removeUser = useMutation({
    mutationFn: (id: string) => api.admin.deleteUser(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  if (detailId) {
    return <UserDetailPanel id={detailId} onBack={() => setDetailId(null)} />;
  }

  return (
    <section>
      <Toolbar
        q={q}
        setQ={(v) => {
          setQ(v);
          setOffset(0);
        }}
        total={list.data?.total ?? 0}
        offset={offset}
        limit={limit}
        setOffset={setOffset}
        placeholder="Search by email or name…"
      />
      {list.isLoading ? (
        <Loading />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel text-left text-xs uppercase tracking-wider text-muted">
              <tr>
                <Th>Email</Th>
                <Th>Name</Th>
                <Th>Verified</Th>
                <Th align="right">Layouts</Th>
                <Th align="right">Size</Th>
                <Th>Created</Th>
                <Th>Admin</Th>
                <Th>Moderator</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {list.data?.users.map((u) => {
                const isSelf = u.id === selfId;
                return (
                  <tr key={u.id} className="border-t border-line">
                    <Td>
                      {/* A long address wraps, so the table fits a tablet. */}
                      <button onClick={() => setDetailId(u.id)} className="text-left text-accent-text wrap-anywhere hover:underline">
                        {u.email}
                      </button>
                    </Td>
                    <Td className="wrap-anywhere">
                      {u.displayName}
                      {u.isDemoAccount && <span className="ml-2 rounded bg-soft px-1.5 py-0.5 text-xs text-muted">Demo</span>}
                    </Td>
                    <Td>
                      {u.emailVerified ? (
                        <span className="text-emerald-400" title="Email verified">✓</span>
                      ) : (
                        <span className="text-amber-400" title="Not verified">✕</span>
                      )}
                    </Td>
                    <Td align="right" className="tabular-nums">{u.layoutCount}</Td>
                    <Td align="right" className="tabular-nums text-muted">{formatBytes(u.layoutSizeBytes)}</Td>
                    <Td>{new Date(u.createdAt).toLocaleDateString()}</Td>
                    <Td>
                      <label className="inline-flex items-center justify-center pointer-coarse:size-11">
                      <input
                        type="checkbox"
                        aria-label={`Site admin: ${u.email}`}
                        checked={u.isGlobalAdmin}
                        disabled={isSelf || u.isDemoAccount}
                        title={isSelf ? "You can't demote yourself" : u.isDemoAccount ? 'The demo account can’t be an admin' : ''}
                        onChange={(e) =>
                          patchAdmin.mutate({ id: u.id, isGlobalAdmin: e.target.checked })
                        }
                      />
                      </label>
                    </Td>
                    <Td>
                      <label className="inline-flex items-center justify-center pointer-coarse:size-11">
                      <input
                        type="checkbox"
                        aria-label={`Moderator: ${u.email}`}
                        checked={!!u.isModerator}
                        disabled={u.isDemoAccount}
                        onChange={(e) => patchModerator.mutate({ id: u.id, isModerator: e.target.checked })}
                      />
                      </label>
                    </Td>
                    <Td align="right">
                      <div className="flex justify-end gap-1 text-xs">
                        <button
                          onClick={async () => {
                            const ok = await askConfirm({
                              title: `Sign ${u.email} out everywhere?`,
                              removes: 'Every session they have is ended, on every device.',
                              keeps: 'Their account and things don’t change; they can sign in again.',
                              confirmLabel: 'Sign out',
                            });
                            if (ok) revokeSessions.mutate(u.id);
                          }}
                          className="rounded-lg border border-border px-2 py-0.5 hover:bg-soft"
                        >
                          Sign out
                        </button>
                        <button
                          disabled={isSelf}
                          onClick={async () => {
                            const ok = await confirmDelete(u.email, {
                              title: `Erase the account ${u.email} now?`,
                              removes:
                                'The account and everything it owns alone (layouts, parts, modules, venues, collections) are erased now, with no waiting time. A club it was the last admin of gets a new admin; a club with nobody else in it goes too.',
                              keeps: 'Clubs keep the things it made, credited “Builder #…”. The audit log keeps what happened, as “Deleted user #…”.',
                              typeName: true,
                            });
                            if (ok) removeUser.mutate(u.id, { onSuccess: () => toastDeleted(u.email) });
                          }}
                          className="rounded-lg border border-red-900 px-2 py-0.5 text-red-300 hover:bg-red-900/40 disabled:opacity-30"
                        >
                          Delete
                        </button>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function UserDetailPanel({ id, onBack }: { id: string; onBack: () => void }) {
  const detail = useQuery({ queryKey: ['admin-user-detail', id], queryFn: () => api.admin.user(id) });

  return (
    <section className="space-y-4">
      <button onClick={onBack} className="text-sm text-accent-text hover:underline">
        ← Back to users
      </button>
      {detail.isLoading && <Loading />}
      {detail.data && (
        <>
          <div>
            <h2 className="text-base font-semibold">{detail.data.user.displayName}</h2>
            <p className="text-sm text-muted">
              {detail.data.user.email}{' '}
              {detail.data.user.emailVerified ? (
                <span className="text-emerald-400">· verified</span>
              ) : (
                <span className="text-amber-400">· not verified</span>
              )}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Clubs', value: detail.data.stats.orgs },
              { label: 'Layouts', value: detail.data.stats.layouts },
              { label: 'Layout size', value: formatBytes(detail.data.stats.layoutSizeBytes) },
              { label: 'Active sessions', value: detail.data.stats.activeSessions },
            ].map((t) => (
              <div key={t.label} className="rounded-lg border border-line bg-panel p-3">
                <p className="text-xs uppercase tracking-wider text-muted">{t.label}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">{t.value}</p>
              </div>
            ))}
          </div>

          <div>
            <h3 className="text-sm font-semibold text-neutral-300">Clubs</h3>
            {detail.data.orgMemberships.length === 0 ? (
              <p className="mt-1 text-sm text-muted">Not a member of any club.</p>
            ) : (
              <ul className="mt-1 divide-y divide-line rounded-lg border border-line">
                {detail.data.orgMemberships.map((m) => (
                  <li key={m.orgId} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span>{m.name} <span className="text-muted">/{m.slug}</span></span>
                    <span className="text-xs uppercase text-muted">{m.role}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h3 className="text-sm font-semibold text-neutral-300">Layouts</h3>
            {detail.data.layouts.length === 0 ? (
              <p className="mt-1 text-sm text-muted">No layouts owned by this user.</p>
            ) : (
              <table className="mt-1 w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wider text-muted">
                  <tr><Th>Title</Th><Th>Updated</Th><Th align="right">Size</Th></tr>
                </thead>
                <tbody>
                  {detail.data.layouts.map((l) => (
                    <tr key={l.id} className="border-t border-line">
                      <Td>
                        <Link to={`/editor/${l.id}`} className="tap-target inline-flex items-center text-accent-text hover:underline">{l.title}</Link>
                      </Td>
                      <Td>{new Date(l.updatedAt).toLocaleString()}</Td>
                      <Td align="right" className="tabular-nums text-muted">{formatBytes(l.sizeBytes)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-neutral-300">Warnings</h3>
            <SubjectWarnings subject={{ kind: 'user', id }} name={detail.data.user.displayName} />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-neutral-300">Use, limits and read-only</h3>
            <SubjectLimitsPanel kind="user" id={id} />
          </div>
        </>
      )}
    </section>
  );
}
