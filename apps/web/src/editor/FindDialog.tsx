// Find & Replace dialog — port of `FindDialog.cpp`.
// Searches brick part numbers and text-cell content. Like desktop it is
// modeless (setModal(false)) — a floating panel that leaves the canvas
// usable — and selects every match live as you type (200 ms debounce,
// FindDialog.cpp:70-117); clicking a listed match selects just it. Replace (current match) and Replace All work
// in both scopes, each as one undo step (FindDialog.cpp:150-189): part
// scope rewrites the matched text inside part numbers (e.g. 3001.1 →
// 3001.5), keeping each brick's position.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import type { BbmMap } from '@cld/model';
import { useEditorStore } from './editorStore';
import { findHits, hitsSelection, replaceHits, type FindHit, type FindScope } from './findReplace';

interface Props {
  map: BbmMap;
  doc: Y.Doc;
  onClose: () => void;
}

/** Margin between the panel and the bars it keeps clear of, in px. */
const GAP = 8;

/**
 * Where the panel fits: below the bars at the top of the editor (the header
 * and the Edit toolbar, however many rows they wrap to) and above the bars at
 * the bottom (a phone's touch bar). Those bars carry `data-keep-clear`.
 */
export function clearBox(bars: Iterable<Element>, viewportHeight: number): { top: number; maxHeight: number } {
  let top = GAP;
  let bottom = viewportHeight - GAP;
  for (const el of bars) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.top + r.height / 2 < viewportHeight / 2) top = Math.max(top, r.bottom + GAP);
    else bottom = Math.min(bottom, r.top - GAP);
  }
  return { top, maxHeight: Math.max(120, bottom - top) };
}

/** Keeps `clearBox` current as the bars wrap, appear (a selection) or go. */
function useClearBox(): { top: number; maxHeight: number } {
  const [box, setBox] = useState(() => ({ top: 64, maxHeight: Math.max(120, window.innerHeight - 72) }));
  useLayoutEffect(() => {
    let frame = 0;
    let watched: Element[] = [];
    const later = () => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; place(); });
    };
    // A bar wrapping onto another row (the window or its contents changed).
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);
    function place() {
      const bars = [...document.querySelectorAll('[data-keep-clear]')];
      if (sizes && (bars.length !== watched.length || bars.some((b, i) => b !== watched[i]))) {
        sizes.disconnect();
        for (const b of bars) sizes.observe(b);
        watched = bars;
      }
      const next = clearBox(bars, window.innerHeight);
      setBox((b) => (b.top === next.top && b.maxHeight === next.maxHeight ? b : next));
    }
    place();
    window.addEventListener('resize', later);
    // A bar showing or going: the touch bar once Find picks parts.
    const added = new MutationObserver(later);
    added.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', later);
      sizes?.disconnect();
      added.disconnect();
    };
  }, []);
  return box;
}

export function FindDialog({ map, doc, onClose }: Props) {
  const box = useClearBox();
  const setMixedSelection = useEditorStore((s) => s.setMixedSelection);
  const [needle, setNeedle] = useState('');
  const [replacement, setReplacement] = useState('');
  // Desktop opens on "Text content", listed first (FindDialog.cpp:36-38).
  const [scope, setScope] = useState<FindScope>('text');
  const [matchCase, setMatchCase] = useState(false);
  // Index of the current match — the one "Replace" acts on.
  const [current, setCurrent] = useState(0);

  const hits = useMemo(() => findHits(map, needle, scope, matchCase), [map, needle, scope, matchCase]);
  const cur = hits.length > 0 ? Math.min(current, hits.length - 1) : -1;

  // Live selection of every match, re-run when the query or the match set
  // changes (desktop also re-runs on every undo-stack change). An empty
  // query deselects everything.
  const hitKey = hits.map((h) => h.brickId ?? `${h.layerId}#${h.textIndex}`).join('|');
  const liveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const t = setTimeout(() => {
      const sel = hitsSelection(hits);
      setMixedSelection(sel.bricks, sel.anno);
    }, 200);
    liveTimer.current = t;
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hitKey, setMixedSelection]);

  function selectHit(h: FindHit) {
    // A click inside the debounce window must win over the pending
    // select-all, or the clicked match is replaced by every match.
    clearTimeout(liveTimer.current);
    const sel = hitsSelection([h]);
    setMixedSelection(sel.bricks, sel.anno);
  }

  function report(count: number) {
    useEditorStore.getState().showNotice(`Replaced ${count} part${count === 1 ? '' : 's'}`);
  }

  function replaceCurrent() {
    const h = hits[cur];
    if (!h) return;
    report(replaceHits(doc, [h], needle, replacement, matchCase));
    // The replaced item usually drops out of the list, so the same index
    // now points at the next match.
  }

  function replaceAll() {
    report(replaceHits(doc, hits, needle, replacement, matchCase));
    setCurrent(0);
  }

  return (
    // Modeless: no backdrop, so the canvas stays live underneath.
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Find & Replace"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}
      // Below the toolbar and above a phone's touch bar, never over their buttons.
      style={{ top: box.top, maxHeight: box.maxHeight }}
      className="fixed right-4 z-40 w-152 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-line bg-panel p-5 shadow-xl"
    >
      <div>
        <h2 className="text-base font-semibold">Find &amp; Replace</h2>

        {/* Scope + options row */}
        <div className="mt-3 flex items-center gap-3 text-xs">
          <select
            aria-label="Find in"
            value={scope}
            onChange={(e) => { setScope(e.target.value as FindScope); setCurrent(0); }}
            className="rounded-lg border border-border bg-soft px-2 py-1"
          >
            <option value="text">Text content</option>
            <option value="part">Part number</option>
          </select>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={matchCase}
              onChange={(e) => setMatchCase(e.target.checked)}
            />
            Match case
          </label>
        </div>

        {/* Find row */}
        <div className="mt-3 flex items-center gap-2">
          <span className="w-16 text-right text-xs text-muted">Find</span>
          <input
            autoFocus
            value={needle}
            onChange={(e) => { setNeedle(e.target.value); setCurrent(0); }}
            placeholder="Search…"
            className="flex-1 rounded-lg border border-border bg-soft px-2 py-1 text-sm"
          />
        </div>

        {/* Replace row */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="w-16 text-right text-xs text-muted">Replace</span>
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder={scope === 'part' ? 'New part-number text…' : 'Replacement…'}
            className="flex-1 rounded-lg border border-border bg-soft px-2 py-1 text-sm"
          />
          <button
            onClick={replaceCurrent}
            disabled={cur < 0}
            title="Replace the current (highlighted) match"
            className="rounded-lg border border-border px-3 py-1 text-xs hover:bg-soft disabled:opacity-40"
          >
            Replace
          </button>
          <button
            onClick={replaceAll}
            disabled={!needle.trim() || hits.length === 0}
            className="rounded-lg bg-accent px-3 py-1 text-xs text-accent-ink hover:bg-accent-hover disabled:opacity-40"
          >
            Replace all
          </button>
        </div>

        {/* Results */}
        <div className="mt-3 max-h-64 min-h-24 overflow-y-auto rounded-lg border border-line">
          {needle.trim() === '' ? (
            <p className="p-2 text-xs text-muted">Type a query above.</p>
          ) : hits.length === 0 ? (
            <p className="p-2 text-xs text-muted">No matches.</p>
          ) : (
            <ul>
              {hits.map((h, i) => (
                <li key={i}>
                  <button
                    onClick={() => {
                      setCurrent(i);
                      selectHit(h);
                    }}
                    onDoubleClick={onClose}
                    aria-current={i === cur ? 'true' : undefined}
                    className={
                      'block w-full px-2 py-1 text-left text-sm hover:bg-soft ' +
                      (i === cur ? 'bg-blue-950/60 text-ink' : '')
                    }
                  >
                    {h.preview}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-3 flex items-center justify-between text-xs text-muted">
          <span>{hits.length} match{hits.length === 1 ? '' : 'es'}</span>
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1 text-sm hover:bg-soft"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
