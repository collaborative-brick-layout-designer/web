// Admin › Clubs: every club, a page at a time; restore or delete; one club's
// detail (also opened from Heavy use).

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatBytes } from '../insights/format';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiSend } from '../../api';
import { SubjectLimitsPanel } from '../limits/LimitsUi';
import { SubjectWarnings } from '../SubjectWarnings';
import { HelpButton } from '../../help/HelpButton';
import { askConfirm, showToast, toastDeleted } from '../../ui/ConfirmDialog';
import { Loading, Td, Th, Toolbar } from './shared';

export function OrgsTab() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const limit = 50;
  const list = useQuery({
    queryKey: ['admin-orgs', q, offset, limit],
    queryFn: () => api.admin.orgs({ q, offset, limit }),
  });
  const removeOrg = useMutation({
    mutationFn: (id: string) => api.admin.deleteOrg(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-orgs'] }),
  });
  const restoreOrg = useMutation({
    mutationFn: (id: string) => apiSend<{ ok: true }>('POST', `/api/admin/orgs/${id}/restore`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-orgs'] }),
  });
  const eraseOrg = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => apiSend<{ ok: true }>('POST', `/api/admin/orgs/${id}/erase`, { confirm: name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-orgs'] }),
  });

  if (detailId) {
    return <OrgDetailPanel id={detailId} onBack={() => setDetailId(null)} />;
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
        placeholder="Search by name or web address…"
      />
      {list.isLoading ? (
        <Loading />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel text-left text-xs uppercase tracking-wider text-muted">
              <tr>
                <Th>Name</Th>
                <Th>Web address</Th>
                <Th>Members</Th>
                <Th align="right">Layouts</Th>
                <Th align="right">Size</Th>
                <Th>Created</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {list.data?.orgs.map((o) => (
                <tr key={o.id} className="border-t border-line">
                  <Td>
                    <button onClick={() => setDetailId(o.id)} className="text-accent-text hover:underline">
                      {o.name}
                    </button>
                    {o.deletionDueAt && (
                      <span className="ml-2 rounded-full bg-amber-500 px-2 py-0.5 text-xs font-semibold text-black" data-testid="org-being-deleted">
                        Being deleted · {new Date(o.deletionDueAt).toLocaleDateString()}
                      </span>
                    )}
                  </Td>
                  <Td>{o.slug}</Td>
                  <Td>{o.memberCount}</Td>
                  <Td align="right" className="tabular-nums">{o.layoutCount}</Td>
                  <Td align="right" className="tabular-nums text-muted">{formatBytes(o.layoutSizeBytes)}</Td>
                  <Td>{new Date(o.createdAt).toLocaleDateString()}</Td>
                  <Td align="right">
                    <div className="flex justify-end gap-2">
                      {o.deletionDueAt ? (
                        <button
                          onClick={() => restoreOrg.mutate(o.id, { onSuccess: () => showToast(`${o.name} is back.`) })}
                          className="rounded-lg border border-border px-2 py-0.5 text-xs hover:bg-soft"
                        >
                          Restore
                        </button>
                      ) : (
                        <button
                          onClick={async () => {
                            const ok = await askConfirm({
                              title: `Delete “${o.name}”?`,
                              removes:
                                'It’s hidden from its members now (each gets a notice) and deleted for good after the waiting time in Settings › Privacy, with its layouts, modules, parts and venues. Its public catalog items go to its longest-standing admin.',
                              keeps: 'Members keep their own things. Until then its admins, or you, can restore it with one click.',
                              confirmLabel: 'Delete',
                              typeName: o.name,
                            });
                            if (ok) removeOrg.mutate(o.id, { onSuccess: () => showToast(`${o.name} is hidden and will be deleted after the waiting time.`) });
                          }}
                          className="rounded-lg border border-red-900 px-2 py-0.5 text-xs text-red-300 hover:bg-red-900/40"
                        >
                          Delete
                        </button>
                      )}
                      <button
                        onClick={async () => {
                          const ok = await askConfirm({
                            title: `Erase “${o.name}” now?`,
                            removes: 'The club and everything it owns are deleted now, with no waiting time and no restore. Its public catalog items go to its longest-standing admin.',
                            keeps: 'Members keep their own things. Copies people added from the catalog stay theirs.',
                            undo: 'This can’t be undone.',
                            confirmLabel: 'Erase now',
                            typeName: o.name,
                          });
                          if (ok) eraseOrg.mutate({ id: o.id, name: o.name }, { onSuccess: () => toastDeleted(o.name) });
                        }}
                        className="rounded-lg border border-red-900 px-2 py-0.5 text-xs text-red-300 hover:bg-red-900/40"
                      >
                        Erase now
                      </button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * Whether the club is trusted. It's changed in one place, Moderation ›
 * Trusted clubs (moderators can't open this page), so this only says
 * which and links there.
 */
function TrustStatus({ name, trusted }: { name: string; trusted: boolean }) {
  return (
    <p data-testid="club-trust-status" className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-3 text-sm">
      {trusted ? <b>Trusted club</b> : <span>Not a trusted club</span>}
      <HelpButton helpKey="club.trusted" />
      <Link to="/admin?tab=moderation&view=clubs" className="text-accent-text hover:underline">
        {trusted ? `Change in Moderation › Trusted clubs` : `Trust ${name} in Moderation › Trusted clubs`}
      </Link>
    </p>
  );
}

export function OrgDetailPanel({ id, onBack }: { id: string; onBack: () => void }) {
  const detail = useQuery({ queryKey: ['admin-org-detail', id], queryFn: () => api.admin.org(id) });

  return (
    <section className="space-y-4">
      <button onClick={onBack} className="text-sm text-accent-text hover:underline">
        ← Back to clubs
      </button>
      {detail.isLoading && <Loading />}
      {detail.data && (
        <>
          <div>
            <h2 className="text-base font-semibold">{detail.data.org.name}</h2>
            <p className="text-sm text-muted">/{detail.data.org.slug}</p>
          </div>
          <TrustStatus name={detail.data.org.name} trusted={!!detail.data.org.trusted} />

          <div className="grid grid-cols-3 gap-3 sm:max-w-md">
            {[
              { label: 'Members', value: detail.data.stats.members },
              { label: 'Layouts', value: detail.data.stats.layouts },
              { label: 'Layout size', value: formatBytes(detail.data.stats.layoutSizeBytes) },
            ].map((t) => (
              <div key={t.label} className="rounded-lg border border-line bg-panel p-3">
                <p className="text-xs uppercase tracking-wider text-muted">{t.label}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">{t.value}</p>
              </div>
            ))}
          </div>

          <div>
            <h3 className="text-sm font-semibold text-neutral-300">Members</h3>
            <ul className="mt-1 divide-y divide-line rounded-lg border border-line">
              {detail.data.members.map((m) => (
                <li key={m.userId} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span>{m.displayName} <span className="text-muted">({m.email})</span></span>
                  <span className="text-xs uppercase text-muted">{m.role}</span>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-neutral-300">Layouts</h3>
            {detail.data.layouts.length === 0 ? (
              <p className="mt-1 text-sm text-muted">No layouts owned by this club.</p>
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
            <SubjectWarnings subject={{ kind: 'org', id }} name={detail.data.org.name} />
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold text-neutral-300">Use, limits and read-only</h3>
            <SubjectLimitsPanel kind="org" id={id} />
          </div>
        </>
      )}
    </section>
  );
}
