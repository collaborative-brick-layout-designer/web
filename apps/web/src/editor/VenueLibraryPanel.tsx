// Venue Library panel — port of VenueLibraryPanel.cpp: lists saved venues
// from the server; the selected one shows its details and can be loaded
// into the layout, renamed (refused onto another saved venue's name,
// VenueLibraryPanel.cpp:244-255) or deleted; "Save Current Venue" saves
// the layout's venue, asking before overwriting one with the same name.

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type * as Y from 'yjs';
import type { Venue } from '@cld/bbm';
import { api } from '../api';
import { setVenue } from './mutations';
import { readSidecarFromDoc } from '@cld/ydoc';
import { useEditorStore } from './editorStore';
import { askOverwrite, saveVenueToLibrary, venueDetail, venueNamed } from './venueLibrary';
import { VenueSaveLibraryDialog } from './VenueSaveLibraryDialog';
import { confirmDelete, toastDeleted } from '../ui/ConfirmDialog';
import { VENUE_DELETE_WORDING } from '../ui/deleteWording';

interface Props {
  doc: Y.Doc;
  isViewer: boolean;
}

export function VenueLibraryPanel({ doc, isViewer }: Props) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState<Venue | null>(null);

  const list = useQuery({
    queryKey: ['venue-library'],
    queryFn: api.venues.list,
    enabled: !isViewer,
  });
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: api.orgs.list, enabled: !isViewer });
  const selected = useQuery({
    queryKey: ['venue-library', selectedId],
    queryFn: () => api.venues.get(selectedId!),
    enabled: !isViewer && selectedId !== null,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['venue-library'] });

  const remove = useMutation({
    mutationFn: (id: string) => api.venues.remove(id),
    onSuccess: (_r, id) => {
      if (id === selectedId) setSelectedId(null);
      void refresh();
    },
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.venues.rename(id, name),
    onSuccess: () => refresh(),
    onError: (e) => alert(`Could not rename the venue: ${(e as Error).message}`),
  });

  const venues = list.data?.venues ?? [];
  const filtered = filter ? venues.filter((v) => v.name.toLowerCase().includes(filter.toLowerCase())) : venues;
  const current = venues.find((v) => v.id === selectedId) ?? null;

  async function load(id: string) {
    try {
      const { data } = await api.venues.get(id);
      setVenue(doc, data as Venue);
    } catch {
      alert('Failed to load venue from library.');
    }
  }

  function onRename(v: { id: string; name: string; ownerOrgId: string | null }) {
    const next = prompt('New name:', v.name)?.trim();
    if (!next || next === v.name) return;
    if (venueNamed(venues, next, v.ownerOrgId, v.id)) {
      alert(`"${next}" already exists.`);
      return;
    }
    rename.mutate({ id: v.id, name: next });
  }

  function onSaveCurrent() {
    const venue = readSidecarFromDoc(doc)?.venue;
    if (!venue) {
      alert('There is no venue on the current project.');
      return;
    }
    setSaving(venue);
  }

  const btn = 'rounded-lg border border-border px-2 py-0.5 hover:bg-neutral-700 disabled:opacity-40';

  return (
    <div className="flex h-full flex-col overflow-y-auto text-xs">
      <div className="border-b border-line p-2">
        <input
          placeholder="Filter venues…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-full rounded-lg border border-border bg-soft px-2 py-1 text-xs"
        />
      </div>

      {isViewer && <p className="p-2 text-muted">Sign in to access the venue library.</p>}
      {!isViewer && list.isLoading && <p className="p-2 text-muted">Loading…</p>}
      {!isViewer && list.isError && <p className="p-2 text-danger">Failed to load venue library.</p>}

      <div className="min-h-[4.5rem] flex-1 overflow-y-auto" role="listbox" aria-label="Saved venues">
        {filtered.length === 0 && !list.isLoading && (
          <p className="p-2 text-muted">{filter ? 'No matches.' : '(no saved venues)'}</p>
        )}
        {filtered.map((v) => (
          <div
            key={v.id}
            role="option"
            aria-selected={v.id === selectedId}
            onClick={() => setSelectedId(v.id)}
            onDoubleClick={() => void load(v.id)}
            className={`cursor-pointer truncate border-b border-line px-2 py-1.5 ${v.id === selectedId ? 'bg-blue-900/40' : 'hover:bg-soft/40'}`}
            title={v.name}
          >
            {v.name}
            {v.ownerOrgId && <span className="ml-1 text-muted">(club)</span>}
          </div>
        ))}
      </div>

      {!isViewer && (
        <div className="space-y-2 border-t border-line p-2">
          <p data-testid="venue-detail" className="min-h-8 whitespace-pre-line text-muted">
            {current ? (selected.data ? venueDetail(selected.data.data as Venue) : selected.isError ? '(could not read venue)' : '') : ''}
          </p>
          <div className="flex flex-wrap gap-1">
            <button className={btn} disabled={!current} onClick={() => current && void load(current.id)}>
              Load into Project
            </button>
            <button className={btn} onClick={onSaveCurrent}>
              Save Current Venue
            </button>
            <button className={btn} disabled={!current} onClick={() => current && onRename(current)}>
              Rename…
            </button>
            <button
              className={`${btn} border-red-900 text-danger hover:bg-red-950`}
              disabled={!current}
              onClick={async () => {
                if (!current || !(await confirmDelete(current.name, VENUE_DELETE_WORDING))) return;
                const name = current.name;
                remove.mutate(current.id, { onSuccess: () => toastDeleted(name) });
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}

      {saving && (
        <VenueSaveLibraryDialog
          venueName={saving.name || ''}
          orgs={orgs.data?.orgs ?? []}
          onSave={(orgSlug, name) => {
            const venue = saving;
            setSaving(null);
            const orgId = orgSlug ? (orgs.data?.orgs.find((o) => o.slug === orgSlug)?.id ?? null) : null;
            void saveVenueToLibrary(venue, name, { ...(orgSlug ? { orgSlug } : {}), orgId }, venues, api.venues, askOverwrite)
              .then((r) => {
                if (r === 'cancelled') return;
                useEditorStore.getState().showNotice('Venue saved to the Venue library.');
                return refresh();
              })
              .catch((e) => alert(`Failed to save venue to library: ${(e as Error).message}`));
          }}
          onClose={() => setSaving(null)}
        />
      )}
    </div>
  );
}
