// Saved venues on the home page: yours and your clubs', together, each with
// its owner chip, narrowed by the home page's owner filter. Start a layout
// from one, download it as a .bld-venue file, upload one, move or copy it
// between you and a club, and, when you manage it (your own, or a club you
// admin), design, rename or delete it.

import { useRef, useState, type ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Venue } from '@cld/bbm';
import { api, type OrgSummary, type VenueSummary } from '../api';
import { parseVenueFile, VENUE_FILE_ACCEPT, VENUE_FILE_EXT, writeVenueFile } from '../editor/venueFile';
import { downloadText } from './venueStart';
import { defaultSaveTo, itemOrgSlug, matchesOwnerFilter, type OwnerFilter } from '../owners/owners';
import { CreditLine, MoveCopyDialog, OwnerChip, ReturnMenuItems, SaveToDialog } from '../owners/OwnerControls';
import { MoreMenu, MORE_ITEM } from '../ui/MoreMenu';
import { atLeast } from '../orgs/clubRoles';
import { confirmDelete, showToast, toastDeleted } from '../ui/ConfirmDialog';
import { RenameDialog } from '../ui/RenameDialog';
import { VENUE_DELETE_WORDING } from '../ui/deleteWording';
import { CatalogBadge, ShareToCatalogDialog, useCatalogStatus } from '../catalog/ShareToCatalog';
import { restoreDeleted } from '../trash/RecentlyDeleted';

/** May change it: the server says so; older servers: yours, or a club you manage. */
export function canManageVenue(v: VenueSummary, orgs: readonly OrgSummary[] | undefined): boolean {
  if (v.canManage !== undefined) return v.canManage;
  if (!v.ownerOrgId) return true;
  return atLeast(orgs?.find((o) => o.id === v.ownerOrgId)?.myRole, 'manager');
}

export function VenueList({
  filter,
  myUserId,
  orgs,
}: {
  filter: OwnerFilter;
  myUserId: string | undefined;
  orgs: readonly OrgSummary[] | undefined;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const venues = useQuery({ queryKey: ['venues'], queryFn: api.venues.list });
  const refresh = () => qc.invalidateQueries({ queryKey: ['venues'] });
  const fail = (what: string) => (e: Error) => showToast(`Couldn’t ${what}: ${e.message}`);
  // Where an upload goes, picked before the file is.
  const uploadTo = useRef('');
  const [asking, setAsking] = useState<'new' | 'upload' | null>(null);
  const [moving, setMoving] = useState<VenueSummary | null>(null);
  const [renaming, setRenaming] = useState<VenueSummary | null>(null);
  const hasClubs = (orgs?.length ?? 0) > 0;
  const catalog = useCatalogStatus();
  const [sharing, setSharing] = useState<VenueSummary | null>(null);

  const upload = useMutation({
    mutationFn: (body: { name: string; data: Venue }) =>
      api.venues.create({ ...body, ...(uploadTo.current ? { orgSlug: uploadTo.current } : {}) }),
    onSuccess: refresh,
    onError: fail('upload the venue'),
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.venues.rename(id, name),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: api.venues.remove, onSuccess: refresh, onError: fail('delete the venue') });

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    let venue: Venue;
    try {
      venue = parseVenueFile(await file.text());
    } catch (err) {
      showToast(`Couldn’t read ${file.name}: ${(err as Error).message}`);
      return;
    }
    const name = venue.name.trim() || file.name.replace(/\.(bld-venue|cld-venue|json)$/i, '');
    upload.mutate({ name, data: { ...venue, name } });
  }

  async function download(id: string, name: string) {
    try {
      const v = await api.venues.get(id);
      downloadText(`${name}${VENUE_FILE_EXT}`, writeVenueFile(v.data as Venue));
    } catch (err) {
      showToast(`Couldn’t download the venue: ${(err as Error).message}`);
    }
  }

  function startNew(slug: string) {
    navigate(`/venues/new${slug ? `?org=${encodeURIComponent(slug)}` : ''}`);
  }
  function startUpload(slug: string) {
    uploadTo.current = slug;
    fileInput.current?.click();
  }

  const list = (venues.data?.venues ?? [])
    .filter((v) => matchesOwnerFilter(v, filter, myUserId, orgs))
    .sort((a, b) => a.name.localeCompare(b.name));
  const startUrl = (v: VenueSummary) => {
    const slug = itemOrgSlug(v, orgs);
    return `/?newLayoutVenue=${encodeURIComponent(v.id)}${slug ? `&owner=${encodeURIComponent(slug)}` : ''}`;
  };
  const designUrl = (v: VenueSummary) => {
    const slug = itemOrgSlug(v, orgs);
    return `/venues/${encodeURIComponent(v.id)}/design${slug ? `?org=${encodeURIComponent(slug)}` : ''}`;
  };
  const btn = 'tap-target inline-flex items-center rounded-lg border border-border px-3 py-1 text-sm hover:bg-soft';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="tap-target inline-flex items-center rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink hover:bg-accent-hover"
          onClick={() => (hasClubs ? setAsking('new') : startNew(''))}
        >
          New venue
        </button>
        <button
          type="button"
          className={btn}
          disabled={upload.isPending}
          onClick={() => (hasClubs ? setAsking('upload') : startUpload(''))}
        >
          Upload venue…
        </button>
      </div>
      {venues.isLoading && <p className="text-sm text-muted">Loading…</p>}
      {venues.data &&
        (list.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line p-4 text-sm text-muted">
            No saved venues here yet. Make a new one, upload a .bld-venue file, or save one from the editor's Venue library.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
            {list.map((v) => {
              const manage = canManageVenue(v, orgs);
              return (
                <li key={v.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="break-words font-medium">{v.name}</span>
                      <OwnerChip item={v} myUserId={myUserId} orgs={orgs} />
                      {catalog.shared('venue', v.id) && <CatalogBadge item={catalog.shared('venue', v.id)!} />}
                    </span>
                    <CreditLine credit={v.credit} />
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Link
                      to={startUrl(v)}
                      className="tap-target inline-flex min-h-9 items-center whitespace-nowrap rounded-lg bg-accent px-3 text-sm font-semibold text-accent-ink hover:bg-accent-hover"
                    >
                      Start layout
                    </Link>
                    <MoreMenu label={`More for ${v.name}`}>
                      {manage && (
                        <Link role="menuitem" to={designUrl(v)} className={MORE_ITEM}>
                          Design
                        </Link>
                      )}
                      <button role="menuitem" type="button" className={MORE_ITEM} onClick={() => void download(v.id, v.name)}>
                        Download
                      </button>
                      {hasClubs && (
                        <button role="menuitem" type="button" className={MORE_ITEM} onClick={() => setMoving(v)}>
                          Move or copy…
                        </button>
                      )}
                      {manage && catalog.enabled('venue') && (
                        <button role="menuitem" type="button" className={MORE_ITEM} onClick={() => setSharing(v)}>
                          {catalog.shared('venue', v.id) ? 'Publish a new version to the catalog…' : 'Share to the public catalog…'}
                        </button>
                      )}
                      <ReturnMenuItems kind="venues" id={v.id} title={v.name} credit={v.credit} />
                      {manage && (
                        <>
                          <button
                            role="menuitem"
                            type="button"
                            className={MORE_ITEM}
                            onClick={() => setRenaming(v)}
                          >
                            Rename…
                          </button>
                          <button
                            role="menuitem"
                            type="button"
                            className={`${MORE_ITEM} text-danger`}
                            onClick={async () => {
                              if (await confirmDelete(v.name, VENUE_DELETE_WORDING))
                                remove.mutate(v.id, { onSuccess: (r) => toastDeleted(v.name, r.trashId ? () => void restoreDeleted(r.trashId) : undefined) });
                            }}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </MoreMenu>
                  </span>
                </li>
              );
            })}
          </ul>
        ))}
      <input
        ref={fileInput}
        type="file"
        accept={VENUE_FILE_ACCEPT}
        onChange={(e) => void pick(e)}
        className="hidden"
        aria-label="Venue file"
      />
      {asking && orgs && (
        <SaveToDialog
          title={asking === 'new' ? 'New venue' : 'Upload a venue'}
          confirmLabel={asking === 'new' ? 'Start designing' : 'Choose file…'}
          initial={defaultSaveTo(filter)}
          orgs={orgs}
          onClose={() => setAsking(null)}
          onConfirm={(slug) => {
            const what = asking;
            setAsking(null);
            if (what === 'new') startNew(slug);
            else startUpload(slug);
          }}
        />
      )}
      {sharing && (
        <ShareToCatalogDialog kind="venue" sourceId={sharing.id} title={sharing.name} existing={catalog.shared('venue', sharing.id)} onClose={() => setSharing(null)} />
      )}
      {renaming && (
        <RenameDialog heading="Rename venue" current={renaming.name} onSave={(name) => rename.mutateAsync({ id: renaming.id, name })} onClose={() => setRenaming(null)} />
      )}
      {moving && orgs && (
        <MoveCopyDialog
          kind="room"
          item={{ id: moving.id, title: moving.name, ownerOrgId: moving.ownerOrgId }}
          canMove={canManageVenue(moving, orgs)}
          orgs={orgs}
          onClose={() => setMoving(null)}
        />
      )}
    </div>
  );
}
