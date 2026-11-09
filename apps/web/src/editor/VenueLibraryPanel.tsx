// Venue Library panel — port of VenueLibraryPanel.cpp: lists saved venues
// from the server; the selected one shows its details and can be loaded
// into the layout ("Use in this layout"), renamed (refused onto another
// saved venue's name, VenueLibraryPanel.cpp:244-255) or deleted; "Save this
// layout's venue" saves it, asking before overwriting one with the same
// name. A layout with no venue yet gets a "Draw your venue" card.

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type * as Y from 'yjs';
import type { Venue } from '@cld/bbm';
import { api } from '../api';
import { setVenue } from './mutations';
import { normalizeVenue } from './venueFile';
import { readSidecarFromDoc } from '@cld/ydoc';
import { useEditorStore } from './editorStore';
import { askOverwrite, saveVenueToLibrary, venueDetail, venueNamed } from './venueLibrary';
import { VenueSaveLibraryDialog } from './VenueSaveLibraryDialog';
import { confirmDelete, toastDeleted } from '../ui/ConfirmDialog';
import { VENUE_DELETE_WORDING } from '../ui/deleteWording';
import { RenameDialog } from '../ui/RenameDialog';
import { useYjsSnapshot } from './useYjsSnapshot';

interface Props {
  doc: Y.Doc;
  isViewer: boolean;
  /** The ways to make the layout's venue, for the "Draw your venue" card. */
  onDrawOutline?: () => void;
  onDimensions?: () => void;
  onDesigner?: () => void;
}

const notice = (text: string, kind: 'done' | 'error' = 'error') => useEditorStore.getState().showNotice(text, kind, kind === 'error' ? 8000 : 6000);

export function VenueLibraryPanel({ doc, isViewer, onDrawOutline, onDimensions, onDesigner }: Props) {
  // The card follows the layout's venue as it's drawn or cleared.
  useYjsSnapshot(doc.getMap('meta') as unknown as Y.AbstractType<unknown>);
  const hasVenue = !!readSidecarFromDoc(doc)?.venue;
  const [renaming, setRenaming] = useState<{ id: string; name: string; ownerOrgId: string | null } | null>(null);
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
  });

  const venues = list.data?.venues ?? [];
  const filtered = filter ? venues.filter((v) => v.name.toLowerCase().includes(filter.toLowerCase())) : venues;
  const current = venues.find((v) => v.id === selectedId) ?? null;

  async function load(id: string) {
    try {
      const { data } = await api.venues.get(id);
      // Read the way a venue file is (every field checked, defaults filled), never as it came.
      setVenue(doc, normalizeVenue(data));
      notice('The venue is in this layout now.', 'done');
    } catch (e) {
      notice(`Couldn’t use that venue: ${(e as Error).message}`);
    }
  }

  async function saveRename(v: { id: string; name: string; ownerOrgId: string | null }, next: string) {
    // Refused onto another saved venue's name (VenueLibraryPanel.cpp:244-255).
    if (venueNamed(venues, next, v.ownerOrgId, v.id)) throw new Error(`There’s already a venue called “${next}”.`);
    await rename.mutateAsync({ id: v.id, name: next });
  }

  function onSaveCurrent() {
    const venue = readSidecarFromDoc(doc)?.venue;
    if (!venue) {
      notice('This layout has no venue yet. Draw one first.');
      return;
    }
    setSaving(venue);
  }

  const btn = 'rounded-lg border border-border px-2 py-0.5 hover:bg-soft disabled:opacity-40';

  return (
    <div className="flex h-full flex-col overflow-y-auto text-xs">
      {!isViewer && !hasVenue && (
        <div data-testid="draw-venue-card" className="space-y-1.5 border-b border-line bg-soft/60 p-2 text-sm">
          <p className="text-xs text-muted">
            <span className="font-semibold text-ink">Draw your venue:</span> the hall your layout has to fit in. Parts too close to its walls are pointed out.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {onDesigner && (
              <button type="button" className="rounded-lg bg-accent px-2.5 py-1 text-xs font-semibold text-accent-ink hover:bg-accent-hover" onClick={onDesigner}>
                Open the venue designer
              </button>
            )}
            {onDrawOutline && (
              <button type="button" className={btn} onClick={onDrawOutline}>
                Draw on the map
              </button>
            )}
            {onDimensions && (
              <button type="button" className={btn} onClick={onDimensions}>
                Type in the sizes…
              </button>
            )}
          </div>
          {venues.length > 0 && <p className="text-xs text-muted">Or pick a saved venue below and choose Use in this layout.</p>}
        </div>
      )}
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
              Use in this layout
            </button>
            <button className={btn} disabled={!hasVenue} title={hasVenue ? undefined : 'This layout has no venue yet'} onClick={onSaveCurrent}>
              Save this layout’s venue…
            </button>
            <button className={btn} disabled={!current} onClick={() => current && setRenaming(current)}>
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
              .catch((e) => notice(`Couldn’t save the venue: ${(e as Error).message}`));
          }}
          onClose={() => setSaving(null)}
        />
      )}
      {renaming && (
        <RenameDialog heading="Rename venue" current={renaming.name} onSave={(name) => saveRename(renaming, name)} onClose={() => setRenaming(null)} />
      )}
    </div>
  );
}
