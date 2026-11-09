// The module editor's Y.Doc: loaded once from the module's snapshot and
// saved back with Save (modules aren't live-shared like layouts, so there's
// no socket). Same shape as useLayoutDoc so the editor can use either.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { canReadDoc, createDefaultLayoutDoc, docToBbm } from '@cld/ydoc';
import { api, ModuleChangedError } from '../api';
import { HINT_EVENT } from '../live/LiveUpdates';
import type { Hint } from '../live/invalidate';
import { repairModuleSheets } from './moduleSheets';
import { UNREADABLE_LAYOUT, type LayoutDocState, type SaveResult, type SaveStatus } from './useLayoutDoc';

/** Whether a module doc has nothing to put parts on (a blank module from before modules opened). */
function hasNoLayers(doc: Y.Doc): boolean {
  try {
    return (docToBbm(doc)?.layers.length ?? 0) === 0;
  } catch {
    return true;
  }
}

/**
 * Someone else saved the module since this editor opened it (or last saved):
 * `refused` when this editor's save was turned down for it (409), otherwise
 * heard live while there were changes here not saved yet.
 */
export interface ModuleChange {
  refused: boolean;
}

export interface ModuleDocState extends LayoutDocState {
  /** Someone else's save is waiting: Load theirs, or Save mine as a new version. */
  moduleChange: ModuleChange | null;
  /** Their version in place of the work here (which isn't saved). */
  loadTheirs: () => void;
  /** This work saved over theirs, as a new version (theirs stays in the history). */
  saveMine: () => Promise<SaveResult>;
  /** Close the card and carry on (the next save asks again). */
  dismissChange: () => void;
}

export function useModuleDoc(moduleId: string): ModuleDocState {
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [awareness, setAwareness] = useState<Awareness | null>(null);
  const [status, setStatus] = useState<SaveStatus>({ kind: 'connecting' });
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const docRef = useRef<Y.Doc | null>(null);
  /** Bumped on every edit, so an edit made while saving still counts as unsaved. */
  const editsRef = useRef(0);
  const afterSaveRef = useRef<(() => Promise<unknown>) | null>(null);
  const noteRef = useRef('');
  /** The module's docVersion this doc is based on (sent as If-Match). */
  const baseRef = useRef<number | undefined>(undefined);
  const [moduleChange, setModuleChange] = useState<ModuleChange | null>(null);
  /** Bumped to read the module again from the server (Load theirs). */
  const [reload, setReload] = useState(0);
  /** Unsaved work here (an edit since the last load or save), and a save on its way. */
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  /** The status as the hint handler reads it ("Saved": nothing here to lose). */
  const statusRef = useRef<SaveStatus>({ kind: 'connecting' });
  statusRef.current = status;
  const setSaveNote = useCallback((note: string) => {
    noteRef.current = note;
  }, []);
  const setAfterSave = useCallback((fn: (() => Promise<unknown>) | null) => {
    afterSaveRef.current = fn;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loaded: Y.Doc | null = null;
    let aw: Awareness | null = null;
    setDoc(null);
    setAwareness(null);
    setLoading(true);
    setLoadError(null);
    setStatus({ kind: 'connecting' });
    editsRef.current = 0;
    dirtyRef.current = false;
    const onUpdate = () => {
      editsRef.current += 1;
      dirtyRef.current = true;
      setStatus({ kind: 'unsaved' });
    };
    void (async () => {
      try {
        const { bytes, docVersion } = await api.modules.snapshotAt(moduleId);
        if (cancelled) return;
        baseRef.current = docVersion;
        setModuleChange(null);
        let d = new Y.Doc();
        Y.applyUpdate(d, bytes);
        if (!canReadDoc(d.getMap('meta').get('schemaVersion'))) throw new Error(UNREADABLE_LAYOUT);
        // A blank module made before modules could be opened has no layers:
        // start it like a new layout (a grid and an empty brick layer).
        if (hasNoLayers(d)) {
          d.destroy();
          d = createDefaultLayoutDoc();
        }
        // Sheets an older web build saved see-through come back solid.
        repairModuleSheets(d);
        loaded = d;
        aw = new Awareness(d);
        d.on('update', onUpdate);
        docRef.current = d;
        setDoc(d);
        setAwareness(aw);
        setStatus({ kind: 'synced' });
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (loaded) {
        loaded.off('update', onUpdate);
        aw?.destroy();
        loaded.destroy();
      }
      docRef.current = null;
    };
  }, [moduleId, reload]);

  // Save: the whole doc goes up as the module's new snapshot, over the
  // version it started from (`force`: over whatever is there now).
  const save = useCallback(async (force: boolean): Promise<SaveResult> => {
    const d = docRef.current;
    if (!d) return 'offline';
    const before = editsRef.current;
    setStatus({ kind: 'saving' });
    savingRef.current = true;
    try {
      const res = await api.modules.saveSnapshot(moduleId, Y.encodeStateAsUpdate(d), noteRef.current, force ? undefined : baseRef.current);
      if (res.docVersion !== undefined) baseRef.current = res.docVersion;
      noteRef.current = '';
      setModuleChange(null);
    } catch (e) {
      setStatus({ kind: 'unsaved' });
      if (e instanceof ModuleChangedError) setModuleChange({ refused: true });
      throw e;
    } finally {
      savingRef.current = false;
    }
    if (editsRef.current === before) dirtyRef.current = false;
    // Its picture; a failed picture never fails the save.
    await afterSaveRef.current?.().catch(() => undefined);
    setStatus(editsRef.current === before ? { kind: 'synced' } : { kind: 'unsaved' });
    return 'saved';
  }, [moduleId]);
  const saveNow = useCallback(() => save(false), [save]);
  const saveMine = useCallback(() => save(true), [save]);
  const loadTheirs = useCallback(() => setReload((n) => n + 1), []);
  const dismissChange = useCallback(() => setModuleChange(null), []);

  // Someone else saves this module (the live hint): with nothing unsaved
  // here it's simply loaded, so the editor always shows the newest; with
  // work here, the card asks what to do.
  useEffect(() => {
    const onHint = (e: Event) => {
      const hint = (e as CustomEvent<Hint>).detail;
      if (hint?.kind !== 'module' || hint.id !== moduleId) return;
      void api.modules
        .get(moduleId)
        .then(({ module }) => {
          // Our own save (its answer may come after the hint), or nothing new.
          if (savingRef.current || baseRef.current === undefined || module.docVersion <= baseRef.current) return;
          if (!dirtyRef.current || statusRef.current.kind === 'synced') setReload((n) => n + 1);
          else setModuleChange((c) => c ?? { refused: false });
        })
        .catch(() => undefined);
    };
    window.addEventListener(HINT_EVENT, onHint);
    return () => window.removeEventListener(HINT_EVENT, onHint);
  }, [moduleId]);

  return useMemo(
    () => ({ doc, awareness, status, saveNow, setAfterSave, setSaveNote, loadError, loading, moduleChange, loadTheirs, saveMine, dismissChange }),
    [doc, awareness, status, saveNow, setAfterSave, setSaveNote, loadError, loading, moduleChange, loadTheirs, saveMine, dismissChange],
  );
}
