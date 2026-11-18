// Shared modules in an open layout: asks the server what the layout
// places (and again whenever a module or the layout changes, by live
// hint), shows the notices (SharedModulesBar), and sends Update, Go back
// and OK. After an update it says what the module now overlaps
// (sharedMarks.ts). On opening, and after each new version, it checks that
// each copy's parts are still its version's; one that was changed outside
// the app gets "Put back ‹owner›'s version" or "Make it mine…". On opening
// it also asks what was updated automatically since you last had the layout
// open ("Updated while you were away"). Also where a refused change to a
// shared module is told to the person (sharedLock.ts).

import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { readSidecarFromDoc } from '@cld/ydoc';
import { matchesVersion, sharedModulesIn, type SharedPlaced } from '@cld/modules';
import { api, type PartWire, type SharedAwayUpdate } from '../api';
import { useEditorStore } from './editorStore';
import { updateSidecarModule } from './mutations';
import { lockMessage, onSharedLock, sharedModule } from './sharedLock';
import { findSharedUpdates, makeItMine, setSharedModulesLayout, type AwayUpdate, type SharedUpdate } from './sharedModules';
import { SharedModulesBar } from './SharedModulesBar';
import { useYjsSnapshot } from './useYjsSnapshot';
import { projectDoc, useDocMap } from './useDocMap';
import { sharedMarks, type SharedMarks } from './sharedMarks';
import { batchesFromBytes, partLookup, placedParts } from './moduleLibrary';
import { lookupPart } from './snap';

/**
 * "Updated while you were away", asked once per opening: the server notes
 * the visit when it answers, so a second ask would say nothing. The editor
 * mounting again right away (React's development double mount, a remount
 * while the document loads) gets the same answer; opening the layout again
 * later asks again.
 */
const awayAsked = new Map<string, { at: number; answer: Promise<SharedAwayUpdate[]> }>();
const AWAY_REUSE_MS = 15_000;

export function whileAwayOnce(layoutId: string, now = Date.now()): Promise<SharedAwayUpdate[]> {
  const had = awayAsked.get(layoutId);
  if (had && now - had.at < AWAY_REUSE_MS) return had.answer;
  const answer = api.sharedModules.whileAway(layoutId).then((r) => r.updates);
  awayAsked.set(layoutId, { at: now, answer });
  return answer;
}

/** The away notice was answered (OK, Go back): a remount doesn't show it again. */
function awaySeen(layoutId: string): void {
  awayAsked.set(layoutId, { at: Date.now(), answer: Promise.resolve([]) });
}

/** The query every part of the editor reads a layout's shared modules from. */
export const sharedModulesKey = (layoutId: string) => ['layout-shared-modules', layoutId] as const;

/** The layout's shared placed modules, following the document. */
export function useSharedPlaced(doc: Y.Doc): SharedPlaced[] {
  useYjsSnapshot(doc.getMap('meta') as unknown as Y.AbstractType<unknown>);
  useYjsSnapshot(doc.getMap('sidecarItems') as unknown as Y.AbstractType<unknown>);
  const sidecar = readSidecarFromDoc(doc);
  return useMemo(() => sharedModulesIn(sidecar as unknown as Record<string, unknown> | null), [sidecar]);
}

/** What the server says about the layout's shared modules; not asked while it places none. */
export function useSharedRows(layoutId: string | null, placed: readonly SharedPlaced[]) {
  // Asked again when the set of placed copies or a version changes (a place, an update, a removal).
  const stamp = placed.map((p) => `${p.placedId}:${p.version ?? 0}`).join(',');
  return useQuery({
    queryKey: [...sharedModulesKey(layoutId ?? ''), stamp],
    queryFn: () => api.sharedModules.list(layoutId!),
    enabled: !!layoutId && placed.length > 0,
    staleTime: 15_000,
  });
}

interface Props {
  doc: Y.Doc;
  /** The layout on the server; null in a module's own editor. */
  layoutId: string | null;
  isViewer: boolean;
  /** Pick these parts and bring them into view. */
  onShowParts: (ids: readonly string[]) => void;
  /** The parts catalog, by key (for outlines, track ends and where a version's parts go). */
  parts: Map<string, PartWire>;
  top?: boolean;
}

export function SharedModulesHost({ doc, layoutId, isViewer, onShowParts, parts, top = false }: Props) {
  const qc = useQueryClient();
  const placed = useSharedPlaced(doc);
  const rows = useSharedRows(layoutId, placed);
  const [busy, setBusy] = useState(false);
  const map = useDocMap(doc);
  const partOf = useMemo(() => partLookup(parts), [parts]);

  useEffect(() => {
    setSharedModulesLayout(layoutId);
    onSharedLock((s, what) => useEditorStore.getState().showNotice(lockMessage(s, what), 'error', 8000));
    return () => {
      setSharedModulesLayout(null);
      onSharedLock(() => undefined);
    };
  }, [layoutId]);

  const updates = useMemo(() => findSharedUpdates(placed, rows.data?.modules ?? []), [placed, rows.data]);
  const reviews = useMemo(() => placed.filter((p) => p.review), [placed]);

  // ---- Updated while you were away (asked once per opening, once the layout's copies are known) ----
  const [awayRows, setAwayRows] = useState<SharedAwayUpdate[]>([]);
  const hasShared = placed.length > 0;
  useEffect(() => {
    if (!layoutId || !hasShared) return;
    let live = true;
    void whileAwayOnce(layoutId)
      .then((list) => {
        if (live) setAwayRows(list);
      })
      // An older server, or no answer: nothing to say.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [layoutId, hasShared]);
  // Only while each copy still has the version the update left it at (Go back, or another update, ends it).
  const away = useMemo<AwayUpdate[]>(
    () =>
      awayRows.flatMap((a) => {
        const p = placed.find((x) => x.placedId === a.placedId);
        return p && p.version === a.to ? [{ placed: p, from: a.from, to: a.to }] : [];
      }),
    [awayRows, placed],
  );
  // The map's badge on each shared module says when a version is ready (render/ModuleOverlay.tsx).
  useEffect(() => {
    useEditorStore.getState().setSharedModuleUpdates(Object.fromEntries(updates.map((u) => [u.placed.placedId, u.latest])));
    return () => useEditorStore.getState().setSharedModuleUpdates({});
  }, [updates]);
  // What each module an update just changed now overlaps (only while its notice is up).
  const marks = useMemo(() => {
    const out: Record<string, SharedMarks> = {};
    if (!map || parts.size === 0) return out;
    for (const p of [...reviews, ...away.map((a) => a.placed)]) out[p.placedId] = sharedMarks(map, new Set(p.members), (n) => lookupPart(parts, n));
    return out;
  }, [map, reviews, away, parts]);
  useEffect(() => {
    useEditorStore.getState().setSharedModuleMarks(marks);
    return () => useEditorStore.getState().setSharedModuleMarks({});
  }, [marks]);

  // ---- Is each copy still its version? (once per copy and version, whatever the answer) ----
  const checked = useRef(new Set<string>());
  const checking = useRef<Y.Doc | null>(null);
  const changedOutside = useEditorStore((s) => s.sharedChangedOutside);
  useEffect(() => {
    checked.current = new Set();
    checking.current = doc;
    useEditorStore.getState().setSharedChangedOutside([]);
    return () => {
      checking.current = null;
    };
  }, [doc]);
  useEffect(() => {
    if (!layoutId || !map || parts.size === 0 || !rows.data) return;
    for (const p of placed) {
      if (!p.version) continue;
      const row = rows.data.modules.find((r) => r.placedId === p.placedId);
      if (!row || row.state === 'gone') continue;
      const key = `${p.placedId}:${p.version}`;
      if (checked.current.has(key)) continue;
      checked.current.add(key);
      void api.sharedModules
        .versionSnapshot(layoutId, p.placedId, p.version)
        .then((bytes) => {
          if (checking.current !== doc) return;
          const now = sharedModule(doc, p.placedId);
          if (!now || now.version !== p.version) return;
          const here = projectDoc(doc);
          if (!here) return;
          const same = matchesVersion(batchesFromBytes(bytes), placedParts(here, now.members), partOf, now.placement);
          const st = useEditorStore.getState();
          const was = st.sharedChangedOutside.filter((id) => id !== p.placedId);
          st.setSharedChangedOutside(same ? was : [...was, p.placedId]);
        })
        // A version the server no longer keeps, or no answer: nothing to say (and not asked again).
        .catch(() => undefined);
    }
  }, [layoutId, map, parts, partOf, placed, rows.data, doc]);
  const drifted = useMemo(() => placed.filter((p) => changedOutside.includes(p.placedId)), [placed, changedOutside]);

  const canUpdate = !isViewer && !!rows.data?.canUpdate;
  const canDetach = !isViewer && !!rows.data?.canDetach;
  if (!layoutId) return null;

  const show = (ids: readonly string[]) => onShowParts(placed.filter((p) => ids.includes(p.placedId)).flatMap((p) => p.members));
  const run = async (step: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    try {
      const said = await step();
      if (said) useEditorStore.getState().showNotice(said, 'done', 6000);
    } catch (e) {
      useEditorStore.getState().showNotice(e instanceof Error ? e.message : String(e), 'error', 8000);
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: sharedModulesKey(layoutId) });
    }
  };
  const update = (list: readonly SharedUpdate[]) =>
    run(async () => {
      if (list.length === 1) {
        const u = list[0]!;
        const r = await api.sharedModules.apply(layoutId, u.placed.placedId, { version: u.latest });
        return r.changed ? null : `“${u.placed.name}” already has version ${r.version}.`;
      }
      const r = await api.sharedModules.applyAll(layoutId);
      return r.skipped.length > 0 ? `Updated ${r.updated.length}. ${r.skipped.length} couldn’t be updated: they are no longer shared.` : null;
    });
  const goBack = (p: SharedPlaced, version: number) =>
    run(async () => {
      await api.sharedModules.apply(layoutId, p.placedId, { version });
      return null;
    });
  // Put back: the owner's version, again, over a copy changed outside the app.
  const putBack = (p: SharedPlaced) =>
    run(async () => {
      await api.sharedModules.apply(layoutId, p.placedId, { ...(p.version ? { version: p.version } : {}), again: true });
      const st = useEditorStore.getState();
      st.setSharedChangedOutside(st.sharedChangedOutside.filter((id) => id !== p.placedId));
      return `“${p.name || 'The module'}” is ${p.by ? `${p.by}’s` : 'its owner’s'} version again.`;
    });
  const mine = (p: SharedPlaced) =>
    void makeItMine(layoutId, p).then((done) => {
      if (!done) return;
      const st = useEditorStore.getState();
      st.setSharedChangedOutside(st.sharedChangedOutside.filter((id) => id !== p.placedId));
      void qc.invalidateQueries({ queryKey: sharedModulesKey(layoutId) });
    });
  // OK: the notice is read. Everyone in the layout stops seeing it.
  const ok = (list: readonly SharedPlaced[]) => {
    doc.transact(() => {
      for (const p of list) {
        updateSidecarModule(doc, p.placedId, (m) => {
          const { review: _review, ...shared } = (m.shared ?? {}) as Record<string, unknown>;
          return { ...m, shared };
        });
      }
    });
  };

  // "Updated while you were away" is read: gone for you, and (for someone who may) its "is now version N" for everyone.
  const awayOk = (list: readonly AwayUpdate[]) => {
    setAwayRows([]);
    awaySeen(layoutId);
    if (canUpdate) ok(list.map((a) => a.placed).filter((p) => p.review));
  };
  const awayGoBack = (p: SharedPlaced, version: number) => {
    setAwayRows([]);
    awaySeen(layoutId);
    goBack(p, version);
  };

  return (
    <SharedModulesBar
      away={away}
      onAwayOk={awayOk}
      updates={updates}
      reviews={reviews}
      marks={marks}
      drifted={drifted}
      canUpdate={canUpdate}
      canDetach={canDetach}
      busy={busy}
      onShow={show}
      onUpdate={update}
      onGoBack={(p, v) => (away.some((a) => a.placed.placedId === p.placedId) ? awayGoBack(p, v) : goBack(p, v))}
      onOk={ok}
      onPutBack={putBack}
      onMakeItMine={mine}
      top={top}
    />
  );
}
