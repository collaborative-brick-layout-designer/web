// "Where should these go?": asked when a module being added has sheets the
// layout doesn't have. One row per such sheet, each going to the picked
// sheet (the default) or a new sheet with its own name; Place puts the
// module down, Cancel puts nothing down. Ask with `chooseModuleSheets(...)`
// from anywhere; the host is mounted once (main.tsx), like ConfirmDialog.
// On a phone it's a sheet at the bottom of the screen.

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import type { BbmMap } from '@cld/model';
import { docToBbm } from '@cld/ydoc';
import { importBricksAsModule, type ModuleBatch } from './mutations';
import { useEditorStore } from './editorStore';
import {
  defaultChoices,
  moduleSheetNames,
  pickedPartsSheet,
  unmatchedSheets,
  type SheetChoice,
  type SheetChoices,
  type UnmatchedSheet,
} from './moduleSheets';
import { displaySheetName } from './activeSheet';

export interface SheetQuestion {
  moduleName: string;
  /** How many sheets the module has (with parts). */
  sheetCount: number;
  unmatched: UnmatchedSheet[];
  /** The layout's parts sheets, top first. */
  sheets: { id: string; name: string }[];
  /** The picked sheet (where new parts go), if it's a parts sheet. */
  picked: string | null;
  initial: SheetChoices;
}

interface Pending {
  q: SheetQuestion;
  resolve: (a: SheetChoices | null) => void;
  seq: number;
}

let seq = 0;
let pending: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Ask the question; resolves with the answer, or null for Cancel. */
export function askWhereSheetsGo(q: SheetQuestion): Promise<SheetChoices | null> {
  pending?.resolve(null);
  return new Promise((resolve) => {
    pending = { q, resolve, seq: ++seq };
    emit();
  });
}

function answer(a: SheetChoices | null): void {
  const p = pending;
  pending = null;
  emit();
  p?.resolve(a);
}

/** Close an open question as cancelled. */
export function closeSheetQuestion(): void {
  if (pending) answer(null);
}

/** The question for adding these batches to `map`; null when every sheet has a match (nothing to ask). */
export function sheetQuestion(map: Pick<BbmMap, 'layers'>, batches: readonly ModuleBatch[], moduleName: string, activeLayerId: string | null): SheetQuestion | null {
  const unmatched = unmatchedSheets(map, batches);
  if (unmatched.length === 0) return null;
  const picked = pickedPartsSheet(map, activeLayerId);
  return {
    moduleName,
    sheetCount: moduleSheetNames(batches).length,
    unmatched,
    sheets: map.layers.filter((l) => l.type === 'brick').reverse().map((l) => ({ id: l.id, name: displaySheetName(l.name) })),
    picked,
    initial: defaultChoices(unmatched, picked),
  };
}

/**
 * Where a module's sheets go in `map`: `{}` straight away when every sheet
 * matches one in the layout, else the person's answer to "Where should
 * these go?", or null when they cancel (put nothing down then).
 */
export async function chooseModuleSheets(map: Pick<BbmMap, 'layers'>, batches: readonly ModuleBatch[], moduleName: string): Promise<SheetChoices | null> {
  const q = sheetQuestion(map, batches, moduleName, useEditorStore.getState().activeLayerId);
  if (!q) return {};
  return askWhereSheetsGo(q);
}

/**
 * Add a module to the layout, asking "Where should these go?" first when
 * it has sheets the layout lacks. Null when cancelled or nothing was placed.
 */
export async function placeModuleAsking(
  doc: Y.Doc,
  batches: ModuleBatch[],
  opts: Omit<Parameters<typeof importBricksAsModule>[2], 'sheets'>,
): Promise<ReturnType<typeof importBricksAsModule>> {
  const sheets = await chooseModuleSheets(docToBbm(doc), batches, opts.name || 'Module');
  if (!sheets) return null;
  return importBricksAsModule(doc, batches, { ...opts, sheets });
}

export function SheetChoiceHost() {
  const p = useSyncExternalStore(subscribe, () => pending);
  // Leaving the editor with the question open puts nothing down.
  useEffect(() => () => closeSheetQuestion(), []);
  if (!p) return null;
  return <SheetChoiceDialog key={p.seq} q={p.q} onAnswer={answer} />;
}

const NEW = '__new__';
const encode = (c: SheetChoice) => ('layerId' in c ? c.layerId : NEW);

const quoteList = (names: readonly string[]) => {
  const q = names.map((n) => `“${n}”`);
  return q.length <= 1 ? q.join('') : `${q.slice(0, -1).join(', ')} or ${q[q.length - 1]}`;
};

export function SheetChoiceDialog({ q, onAnswer }: { q: SheetQuestion; onAnswer: (a: SheetChoices | null) => void }) {
  const [choices, setChoices] = useState<SheetChoices>(q.initial);
  const titleId = useId();
  const place = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    place.current?.focus();
    return () => before?.focus?.();
  }, []);
  const missing = q.unmatched.map((u) => u.name);
  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onAnswer(null);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="sheet-choice-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onAnswer(null);
          }
        }}
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-section border border-line bg-panel p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-sm text-ink shadow-pop sm:max-w-md sm:rounded-section sm:pb-5"
      >
        <h2 id={titleId} className="text-lg font-semibold">
          Where should these go?
        </h2>
        <p className="mt-2 text-muted">
          “{q.moduleName}” uses {q.sheetCount === 1 ? 'a sheet' : `${q.sheetCount} sheets`}. Your layout doesn’t have {quoteList(missing)}.
        </p>
        <ul className="mt-3 flex flex-col gap-3">
          {q.unmatched.map((u) => {
            const c = choices[u.name] ?? q.initial[u.name]!;
            return (
              <li key={u.name}>
                <label className="block">
                  <span className="mb-1 block font-semibold">
                    {u.name} <span className="font-normal text-muted">({u.parts} {u.parts === 1 ? 'part' : 'parts'})</span>
                  </span>
                  <select
                    value={encode(c)}
                    aria-label={`Where the parts on ${u.name} go`}
                    onChange={(e) => {
                      const v = e.target.value;
                      setChoices((all) => ({ ...all, [u.name]: v === NEW ? { newName: u.name } : { layerId: v } }));
                    }}
                    // 16 px on phones, so iOS doesn't zoom in.
                    className="min-h-11 w-full rounded-lg border border-border bg-soft px-3 text-base sm:min-h-9 sm:text-sm"
                  >
                    {q.sheets.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name || 'untitled'}
                        {s.id === q.picked ? ' (picked sheet)' : ''}
                      </option>
                    ))}
                    <option value={NEW}>A new sheet named “{u.name}”</option>
                  </select>
                </label>
              </li>
            );
          })}
        </ul>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={() => onAnswer(null)}
            className="tap-target min-h-11 rounded-lg border border-border px-4 py-2 hover:bg-soft pointer-fine:min-h-9"
          >
            Cancel
          </button>
          <button
            ref={place}
            type="button"
            onClick={() => onAnswer({ ...q.initial, ...choices })}
            className="tap-target min-h-11 rounded-lg bg-accent px-4 py-2 font-semibold text-accent-ink hover:bg-accent-hover pointer-fine:min-h-9"
          >
            Place
          </button>
        </div>
      </div>
    </div>
  );
}
