// The module dialogs (moduleLibrary.ts has the rules):
//   - Make a module: the picked parts become a module in this layout. "Also
//     save to my Module library" saves it there too, in one go.
//   - Save to Module library…: a placed module goes to your modules or a club's (a
//     new library module, or a new version of one you can change), and is
//     linked to it.
//   - Update Module library version: a linked module's parts become the Module library's
//     next version, with a "What changed?" note.
// ModuleDialogHost shows whichever one the editor store asks for.

import { useState } from 'react';
import type * as Y from 'yjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { readSidecarFromDoc } from '@cld/ydoc';
import type { BbmMap } from '@cld/model';
import { api } from '../api';
import { clubCanAdd } from '../orgs/clubPermissions';
import { SaveToPicker } from '../owners/OwnerControls';
import { moveToClubWording } from '../owners/owners';
import { ModuleThumb } from '../modules/ModuleThumb';
import { useEscape } from './useEscape';
import { HelpButton } from '../help/HelpButton';
import type { HelpKey } from '../help/helpTexts';
import { askConfirm } from '../ui/ConfirmDialog';
import { useEditorStore } from './editorStore';
import { bricksByLayer, createSidecarModule } from './mutations';
import { libraryState, publishModuleVersion, saveModuleToLibrary, type MakeThumbnail } from './moduleLibrary';
import { oneSheetName, pickedBySheet } from './moduleSheets';
import { useDocMap } from './useDocMap';
import { coarsePointer } from './useViewportSize';
import { MAX_NAME_LENGTH } from '../ui/RenameDialog';
import { displaySheetName } from './activeSheet';

const FIELD = 'w-full rounded-lg border border-border bg-soft px-3 py-1.5 text-sm outline-hidden focus:border-accent';

/** Asks before a new module goes straight into a club (the club will own it). */
async function confirmClub(clubName: string): Promise<boolean> {
  const w = moveToClubWording(clubName);
  return askConfirm({ title: `Save it to ${clubName}?`, removes: w.removes, keeps: w.keeps, confirmLabel: 'Save', danger: false });
}

/** "This module uses 2 sheets: Track, Buildings" and "Put everything on one sheet" (shown with two or more). */
function SheetsNote({ map, members, oneSheet, setOneSheet }: {
  map: BbmMap;
  members: readonly string[];
  oneSheet: boolean;
  setOneSheet: (on: boolean) => void;
}) {
  const sheets = pickedBySheet(map, members);
  if (sheets.length < 2) return null;
  return (
    <div data-testid="module-sheets" className="rounded-lg border border-line p-2 text-xs">
      <p className="flex items-start gap-1">
        <span className="flex-1">
          {oneSheet ? (
            <>All its parts go on one sheet: <b>{oneSheetName(sheets)}</b>.</>
          ) : (
            <>This module uses {sheets.length} sheets: <b>{sheets.map((g) => (g.layer.name ? displaySheetName(g.layer.name) : 'untitled')).join(', ')}</b>.</>
          )}
        </span>
        <HelpButton helpKey="module.sheets" />
      </p>
      <label className="mt-1.5 flex items-center gap-2">
        <input type="checkbox" checked={oneSheet} onChange={(e) => setOneSheet(e.target.checked)} />
        Put everything on one sheet
      </label>
    </div>
  );
}

function Shell({ title, help, onClose, children }: { title: string; help?: HelpKey; onClose: () => void; children: React.ReactNode }) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-no-gesture>
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-sm rounded-lg border border-border bg-panel p-5 text-ink shadow-xl">
        <h2 className="mb-4 flex items-center gap-1 text-sm font-semibold">
          <span className="flex-1">{title}</span>
          {help && <HelpButton helpKey={help} />}
        </h2>
        {children}
      </div>
    </div>
  );
}

function Buttons({ onClose, busy, label, busyLabel }: { onClose: () => void; busy: boolean; label: string; busyLabel: string }) {
  return (
    <div className="flex justify-end gap-2">
      <button type="button" onClick={onClose} className="min-h-9 rounded-lg px-3 py-1.5 text-xs text-muted hover:bg-soft pointer-coarse:min-h-11">
        Cancel
      </button>
      <button
        type="submit"
        disabled={busy}
        className="min-h-9 rounded-lg bg-accent px-3 py-1.5 text-xs text-accent-ink hover:bg-accent-hover disabled:opacity-50 pointer-coarse:min-h-11"
      >
        {busy ? busyLabel : label}
      </button>
    </div>
  );
}

interface Common {
  doc: Y.Doc;
  onClose: () => void;
  /** The club that owns the layout being edited, if any: the default owner of a new library module. */
  layoutOwnerOrgId?: string | null;
  makeThumbnail?: MakeThumbnail | undefined;
}

/** Who a new library module is saved to: picked, else the layout's club (if you're in it), else you. */
function useOwner(layoutOwnerOrgId: string | null | undefined) {
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: api.orgs.list });
  const [picked, setPicked] = useState<string | null>(null);
  // Not a club that keeps adding to its admins, for one of its members.
  const layoutClub = orgs.data?.orgs.find((o) => o.id === layoutOwnerOrgId && clubCanAdd(o, 'module'))?.slug ?? '';
  const slug = picked ?? layoutClub;
  const clubName = slug ? (orgs.data?.orgs.find((o) => o.slug === slug)?.name ?? slug) : null;
  return { slug, setSlug: setPicked, orgs: orgs.data?.orgs, clubName };
}

/**
 * What Make a module says when the module is in this layout only: where its
 * Module library entry is. By touch there's no ⋯ menu: the touch bar's Module button opens it.
 */
export function madeModuleNotice(title: string, touch: boolean): string {
  return touch
    ? `“${title}” is a module in this layout. To use it in other layouts, pick it, tap Module, then Save to Module library….`
    : `“${title}” is a module in this layout. To use it in other layouts, choose Save to Module library… from its ⋯ menu.`;
}

function savedMessage(title: string, version: number | undefined): string {
  return version && version > 1 ? `Saved “${title}” to the Module library as version ${version}` : `Saved “${title}” to the Module library`;
}

/** Make a module from the picked parts; "Also save to my Module library" saves it there too. */
export function MakeModuleDialog({ doc, onClose, layoutOwnerOrgId, makeThumbnail, selection }: Common & { selection: readonly string[] }) {
  const map = useDocMap(doc);
  const [name, setName] = useState('');
  const [alsoSave, setAlsoSave] = useState(false);
  const [oneSheet, setOneSheet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = useOwner(layoutOwnerOrgId);
  const qc = useQueryClient();
  const members = map ? [...bricksByLayer(map, [...selection]).values()].flat() : [];

  const make = useMutation({
    mutationFn: async (title: string) => {
      if (alsoSave && owner.clubName && !(await confirmClub(owner.clubName))) return null;
      const id = createSidecarModule(doc, title, members);
      if (!id) throw new Error('Select one or more parts first.');
      if (!alsoSave) return { id, saved: null };
      try {
        const saved = await saveModuleToLibrary(doc, id, { title, ownerSlug: owner.slug, oneSheet, makeThumbnail });
        return { id, saved };
      } catch (e) {
        // The module stays in the layout; only the Module library copy failed.
        throw new Error(`“${title}” is a module in this layout, but it couldn’t be saved to the Module library: ${(e as Error).message}`, { cause: e });
      }
    },
    onSuccess: (r, title) => {
      if (!r) return;
      const { showNotice, showStatusMessage } = useEditorStore.getState();
      if (r.saved) {
        void qc.invalidateQueries({ queryKey: ['modules'] });
        showStatusMessage(savedMessage(r.saved.title, r.saved.version), 5000);
      } else {
        showNotice(madeModuleNotice(title, coarsePointer()));
      }
      onClose();
    },
    onError: (e) => {
      // Made, but not saved: the dialog's job is done; say what didn't happen.
      useEditorStore.getState().showNotice((e as Error).message, 'error', 10000);
      onClose();
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const title = name.trim();
    if (!title) {
      setError('Give the module a name.');
      return;
    }
    if (members.length === 0) {
      setError('Select one or more parts first.');
      return;
    }
    make.mutate(title);
  }

  return (
    <Shell title="Make a module" help="module.make" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-xs text-muted">
          The {members.length === 1 ? 'picked part becomes' : `${members.length} picked parts become`} one module in this layout. It moves as one piece.
        </p>
        <div>
          <label htmlFor="make-module-name" className="mb-1 block text-xs text-muted">Module name</label>
          <input id="make-module-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_NAME_LENGTH} placeholder="e.g. Desert corner" className={FIELD} />
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={alsoSave} onChange={(e) => setAlsoSave(e.target.checked)} data-testid="make-module-also-save" />
          Also save to my Module library, to use it in other layouts
        </label>
        {alsoSave && (
          <>
            <SaveToPicker value={owner.slug} onChange={owner.setSlug} orgs={owner.orgs} kind="module" />
            {map && <SheetsNote map={map} members={members} oneSheet={oneSheet} setOneSheet={setOneSheet} />}
          </>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
        <Buttons onClose={onClose} busy={make.isPending} label={alsoSave ? 'Make and save' : 'Make module'} busyLabel="Saving…" />
      </form>
    </Shell>
  );
}

/** Save to Module library…: a placed module to your modules or a club's, then linked to it. */
export function SaveToLibraryDialog({ doc, moduleId, onClose, layoutOwnerOrgId, makeThumbnail }: Common & { moduleId: string }) {
  const map = useDocMap(doc);
  const mod = readSidecarFromDoc(doc)?.modules?.find((m) => m.id === moduleId);
  const [title, setTitle] = useState(mod?.name ?? '');
  const [mode, setMode] = useState<'new' | 'update'>('new');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [oneSheet, setOneSheet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = useOwner(layoutOwnerOrgId);
  const modules = useQuery({ queryKey: ['modules'], queryFn: api.modules.list });
  const editable = (modules.data?.modules ?? []).filter((m) => m.role === undefined || m.role === 'owner' || m.role === 'editor');
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: async () => {
      if (mode === 'new' && owner.clubName && !(await confirmClub(owner.clubName))) return null;
      const existing = mode === 'update' ? editable.find((m) => m.id === target) : undefined;
      return saveModuleToLibrary(doc, moduleId, {
        title: existing?.title ?? title.trim(),
        ownerSlug: owner.slug,
        note,
        oneSheet,
        ...(existing ? { updateId: existing.id } : {}),
        makeThumbnail,
      });
    },
    onSuccess: (r) => {
      if (!r) return;
      void qc.invalidateQueries({ queryKey: ['modules'] });
      useEditorStore.getState().showStatusMessage(savedMessage(r.title, r.version), 5000);
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });

  if (!mod) return null;
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === 'update' && !target) return setError('Pick the Module library module to update.');
    if (mode === 'new' && !title.trim()) return setError('Module name is required');
    save.mutate();
  }

  return (
    <Shell title={`Save “${mod.name || 'module'}” to the Module library`} help="module.library" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-xs text-muted">A copy goes to your Module library, so you and your club can use it in other layouts. This module stays linked to it.</p>
        <fieldset className="flex flex-col gap-1 text-xs">
          <legend className="sr-only">Save as</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="save-module-mode" checked={mode === 'new'} onChange={() => setMode('new')} />
            New module in the Module library
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="save-module-mode" checked={mode === 'update'} disabled={editable.length === 0} onChange={() => setMode('update')} />
            New version of a module in the Module library{editable.length === 0 ? ' (none you can change yet)' : ''}
          </label>
        </fieldset>
        {mode === 'new' ? (
          <>
            <div>
              <label htmlFor="save-module-name" className="mb-1 block text-xs text-muted">Module name</label>
              <input id="save-module-name" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={MAX_NAME_LENGTH} placeholder="My module" className={FIELD} />
            </div>
            <SaveToPicker value={owner.slug} onChange={owner.setSlug} orgs={owner.orgs} kind="module" />
          </>
        ) : (
          <div role="radiogroup" aria-label="Module to update" className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-line p-1">
            {editable.map((m) => (
              <label
                key={m.id}
                className={`flex cursor-pointer items-center gap-2 rounded-lg p-1.5 text-xs ${target === m.id ? 'bg-soft ring-1 ring-accent' : 'hover:bg-soft'}`}
              >
                <input type="radio" name="save-module-target" value={m.id} checked={target === m.id} onChange={() => setTarget(m.id)} className="sr-only" />
                <ModuleThumb module={m} size="sm" />
                <span className="min-w-0 flex-1 break-words font-medium">{m.title}</span>
                {m.latestVersion ? <span className="shrink-0 text-muted">v{m.latestVersion}</span> : null}
              </label>
            ))}
          </div>
        )}
        <div>
          <label htmlFor="save-module-note" className="mb-1 block text-xs text-muted">What changed? (optional)</label>
          <input
            id="save-module-note"
            value={note}
            maxLength={300}
            onChange={(e) => setNote(e.target.value)}
            placeholder={mode === 'update' ? 'e.g. Longer siding' : 'e.g. First version'}
            className={FIELD}
          />
        </div>
        {map && <SheetsNote map={map} members={mod.members} oneSheet={oneSheet} setOneSheet={setOneSheet} />}
        {error && <p className="text-xs text-danger">{error}</p>}
        <Buttons onClose={onClose} busy={save.isPending} label="Save" busyLabel="Saving…" />
      </form>
    </Shell>
  );
}

/** Update Module library version: this layout's copy becomes the Module library's next version. */
export function PublishModuleDialog({ doc, moduleId, onClose, makeThumbnail }: Common & { moduleId: string }) {
  const map = useDocMap(doc);
  const mod = readSidecarFromDoc(doc)?.modules?.find((m) => m.id === moduleId);
  const modules = useQuery({ queryKey: ['modules'], queryFn: api.modules.list });
  const state = mod ? libraryState(mod, modules.data?.modules) : null;
  const [note, setNote] = useState('');
  const [oneSheet, setOneSheet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const publish = useMutation({
    mutationFn: () => publishModuleVersion(doc, moduleId, { note, oneSheet, makeThumbnail }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['modules'] });
      const title = state?.kind === 'linked' ? state.title : mod?.name || 'module';
      useEditorStore.getState().showStatusMessage(savedMessage(title, r.version), 5000);
      onClose();
    },
    onError: (e) => setError((e as Error).message),
  });
  if (!mod) return null;
  const linked = state?.kind === 'linked' ? state : null;
  return (
    <Shell title="Update Module library version" help="module.library" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          publish.mutate();
        }}
        className="flex flex-col gap-3"
      >
        {linked ? (
          <p className="text-xs">
            This module’s parts in this layout become version {linked.latest + 1} of <b>{linked.title}</b> in the Module library. Layouts that use it can then update to it.
          </p>
        ) : state?.kind === 'missing' ? null : (
          <p className="text-xs text-muted">Loading the Module library…</p>
        )}
        {linked && !linked.canPublish && (
          <p className="text-xs text-danger">You can’t change “{linked.title}” in the Module library. Use Save to Module library… to save your own copy instead.</p>
        )}
        {state?.kind === 'missing' && (
          <p className="text-xs text-danger">Its Module library copy is gone, or isn’t shared with you. Use Save to Module library… to save it again.</p>
        )}
        {linked && linked.newer && linked.version !== null && (
          <p data-testid="publish-newer" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-2 text-xs">
            The Module library has version {linked.latest}, newer than the version {linked.version} this layout has. Saving puts your copy on top; what changed in version {linked.latest} isn’t in it. To keep those changes, use Update from Module library first.
          </p>
        )}
        <div>
          <label htmlFor="publish-module-note" className="mb-1 block text-xs text-muted">What changed? (optional)</label>
          <input id="publish-module-note" autoFocus value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Longer siding" className={FIELD} />
        </div>
        {map && <SheetsNote map={map} members={mod.members} oneSheet={oneSheet} setOneSheet={setOneSheet} />}
        {error && <p className="text-xs text-danger">{error}</p>}
        <Buttons onClose={onClose} busy={publish.isPending || !linked || !linked.canPublish} label="Save version" busyLabel={publish.isPending ? 'Saving…' : 'Save version'} />
      </form>
    </Shell>
  );
}

/** Whichever module dialog the editor store asks for. */
export function ModuleDialogHost({ doc, layoutOwnerOrgId, makeThumbnail }: Omit<Common, 'onClose'>) {
  const dialog = useEditorStore((s) => s.moduleDialog);
  const close = () => useEditorStore.getState().setModuleDialog(null);
  if (!dialog) return null;
  if (dialog.kind === 'make') {
    return (
      <MakeModuleDialog
        doc={doc}
        selection={useEditorStore.getState().selection}
        onClose={close}
        layoutOwnerOrgId={layoutOwnerOrgId ?? null}
        {...(makeThumbnail ? { makeThumbnail } : {})}
      />
    );
  }
  const Dialog = dialog.kind === 'save' ? SaveToLibraryDialog : PublishModuleDialog;
  return (
    <Dialog
      key={dialog.moduleId}
      doc={doc}
      moduleId={dialog.moduleId}
      onClose={close}
      layoutOwnerOrgId={layoutOwnerOrgId ?? null}
      {...(makeThumbnail ? { makeThumbnail } : {})}
    />
  );
}
