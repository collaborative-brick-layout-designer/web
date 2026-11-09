// Admin › Audit log: everything that happened, a page at a time.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type AdminAuditEvent, type DeletedLayout } from '../../api';
import { Loading, Td, Th } from './shared';

const AUDIT_PAGE = 50;

/** Events an admin should read in words, not as a type name. */
export function auditSentence(e: AdminAuditEvent): string | null {
  const p = (e.payload ?? {}) as { foreignLayers?: number; unseenClients?: number; client?: string; kind?: string; why?: string };
  const from = p.client ? ` (from ${p.client})` : '';
  switch (e.eventType) {
    case 'layout_delete': {
      const d = (e.payload ?? {}) as { title?: string; owner?: string; clubName?: string | null };
      return `Deleted the layout “${d.title ?? '?'}”${d.owner === 'club' ? ` (the club ${d.clubName ?? 'it belonged to'}’s)` : ''}.`;
    }
    case 'admin_layout_delete':
      return `A site admin deleted the layout “${(e.payload as { title?: string } | null)?.title ?? '?'}”.`;
    case 'layout_merge_refused':
      return `Refused a live update that would have mixed another layout into this one: it brought ${p.foreignLayers ?? 'some'} layers from elsewhere${from}. Nothing was changed, and that connection was closed.`;
    case 'layout_merge_suspected':
      return `Applied a live update that came from ${p.unseenClients ?? 'many'} editors this layout had never seen at once${from}. Worth a look: it can mean another layout's edits were mixed in.`;
    case 'layout_update_refused':
      return p.kind === 'incomplete'
        ? `Refused a live update that depended on changes this layout doesn't have, past what a layout keeps waiting${from}. What was waiting from it was dropped, and that connection was closed.`
        : `Refused a live update the apps can't read${p.why ? ` (${p.why})` : ''}${from}. Nothing was changed, and that connection was closed.`;
    default:
      return null;
  }
}

export function AuditTab() {
  const [view, setView] = useState<'all' | 'deleted'>('all');
  /** A deleted layout whose whole history is shown. */
  const [layout, setLayout] = useState<DeletedLayout | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-neutral-300">Platform audit log</h2>
        <div role="radiogroup" aria-label="Show" className="flex rounded-lg border border-border p-0.5 text-xs">
          {(['all', 'deleted'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={view === v}
              onClick={() => {
                setView(v);
                setLayout(null);
              }}
              className={`tap-target rounded-md px-3 py-1 ${view === v ? 'bg-accent font-semibold text-accent-ink' : 'text-muted hover:bg-soft'}`}
            >
              {v === 'all' ? 'Everything' : 'Deleted layouts'}
            </button>
          ))}
        </div>
      </div>
      {view === 'all' ? <AuditLog /> : layout ? <AuditLog layout={layout} onBack={() => setLayout(null)} /> : <DeletedLayouts onOpen={setLayout} />}
    </div>
  );
}

/** Layouts deleted by their owner or a site admin; each opens its whole history. */
function DeletedLayouts({ onOpen }: { onOpen: (l: DeletedLayout) => void }) {
  const [offset, setOffset] = useState(0);
  const list = useQuery({ queryKey: ['admin-deleted-layouts', offset], queryFn: () => api.admin.deletedLayouts({ limit: AUDIT_PAGE, offset }) });
  return (
    <div className="space-y-3" data-testid="deleted-layouts">
      <details className="text-xs text-muted">
        <summary className="cursor-pointer select-none">ⓘ What’s this?</summary>
        <p className="mt-1 max-w-prose">
          Every layout deleted by its owner or by a site admin, newest first, named as it was when it was deleted. Open one to read its whole
          history: who made it, shared it, changed it and deleted it. These records are kept, and trimmed, like the rest of the audit log
          (Admin › Site settings › Privacy).
        </p>
      </details>
      {list.isLoading && <Loading />}
      {list.data && list.data.layouts.length === 0 && <p className="text-sm text-muted">No layouts have been deleted.</p>}
      {list.data && list.data.layouts.length > 0 && (
        <>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <Th>Layout</Th><Th>Deleted</Th><Th>By</Th><Th>History</Th>
              </tr>
            </thead>
            <tbody>
              {list.data.layouts.map((l) => (
                <tr key={l.layoutId} className="border-b border-line hover:bg-panel/40">
                  <Td>
                    {l.title ?? <span className="text-muted">(no title recorded)</span>}
                    {l.club && <span className="ml-1 text-muted">· {l.club}</span>}
                  </Td>
                  <Td>{new Date(l.deletedAt).toLocaleString()}</Td>
                  <Td>
                    {l.deletedBy ?? '—'}
                    <span className="ml-1 text-muted">({l.by === 'admin' ? 'site admin' : 'owner'})</span>
                  </Td>
                  <Td>
                    <button type="button" onClick={() => onOpen(l)} className="tap-target rounded-lg border border-border px-2 py-1 hover:bg-soft">
                      Open history ({l.events})
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager offset={offset} shown={list.data.layouts.length} total={list.data.total} setOffset={setOffset} />
        </>
      )}
    </div>
  );
}

function Pager({ offset, shown, total, setOffset }: { offset: number; shown: number; total: number; setOffset: (n: number) => void }) {
  return (
    <div className="flex gap-3 text-xs text-muted">
      <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - AUDIT_PAGE))} className="rounded-lg border border-border px-2 py-1 hover:bg-soft disabled:opacity-40">
        ← Prev
      </button>
      <span className="py-1">
        {total === 0 ? 0 : offset + 1}–{offset + shown} of {total}
      </span>
      <button disabled={offset + AUDIT_PAGE >= total} onClick={() => setOffset(offset + AUDIT_PAGE)} className="rounded-lg border border-border px-2 py-1 hover:bg-soft disabled:opacity-40">
        Next →
      </button>
    </div>
  );
}

/** The log: everything, or one (deleted) layout's whole history. */
function AuditLog({ layout, onBack }: { layout?: DeletedLayout; onBack?: () => void }) {
  const [offset, setOffset] = useState(0);
  const log = useQuery({
    queryKey: ['admin-audit', offset, layout?.layoutId ?? null],
    queryFn: () => api.admin.auditLog({ limit: AUDIT_PAGE, offset, ...(layout ? { layout: layout.layoutId } : {}) }),
  });

  return (
    <div className="space-y-4">
      {layout && (
        <div className="flex flex-wrap items-center gap-3" data-testid="layout-history">
          <button type="button" onClick={onBack} className="tap-target rounded-lg border border-border px-2 py-1 text-xs hover:bg-soft">
            ← Deleted layouts
          </button>
          <h3 className="text-sm font-semibold text-ink">History of “{layout.title ?? layout.layoutId}”</h3>
        </div>
      )}
      {log.isLoading && <Loading />}
      {log.data && (
        <>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <Th>Time</Th><Th>Event</Th><Th>User</Th><Th>Resource</Th><Th>Payload</Th>
              </tr>
            </thead>
            <tbody>
              {log.data.events.map((e: AdminAuditEvent) => (
                <tr key={e.id} className="border-b border-line hover:bg-panel/40">
                  <Td>{new Date(e.createdAt).toLocaleString()}</Td>
                  <Td>
                    {e.eventType}
                    {auditSentence(e) && <p className="mt-0.5 max-w-sm text-neutral-300">{auditSentence(e)}</p>}
                  </Td>
                  <Td>{e.userName ?? e.userId ?? '—'}</Td>
                  <Td className="font-mono text-[10px] text-muted">{e.layoutId ?? (e.resourceKind ? `${e.resourceKind}:${e.resourceId}` : '—')}</Td>
                  <Td>
                    <details>
                      <summary className="cursor-pointer text-muted pointer-coarse:min-w-11">view</summary>
                      <pre className="mt-1 max-w-xs overflow-auto whitespace-pre-wrap text-neutral-300">
                        {JSON.stringify(e.payload, null, 2)}
                      </pre>
                    </details>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager offset={offset} shown={log.data.events.length} total={log.data.total} setOffset={setOffset} />
        </>
      )}
    </div>
  );
}
