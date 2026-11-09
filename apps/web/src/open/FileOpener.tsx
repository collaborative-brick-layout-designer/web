// Open a file, from anywhere: Home's "Open a file…" button, the editor's
// Map › File › Open a file…, or a file dropped on any page. Opens any
// .bld-layout, any .bbm with the `.bbm.bld` sidecar dropped alongside it
// (or both inside a .zip, as the editor's Download .bbm writes them), and
// TrackDesigner / 4DBrix maps, like desktop's open (MainWindowFileIO.cpp).
// Each one becomes a new layout and opens in the editor, which says what
// came in. LDraw, Studio and LDD files get the desktop app's steps.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { layoutsFromFiles, type DroppedLayout } from '../bbmFiles';
import { takeLayoutParts, type PartChoice, type PartDifference } from '../layoutParts';
import { PartDifferencesDialog } from '../layouts/PartDifferencesDialog';
import { catalogMapConverter, type OpenedMapState } from '../mapFormats';
import { HelpButton } from '../help/HelpButton';
import { DesktopOnlySteps } from './DesktopOnly';
import { OPEN_FORMATS_LINE, OPEN_PICKER_ACCEPT, sortFiles, titleFromFileName, type DesktopOnlyFormat } from './openFiles';

let pickerInput: HTMLInputElement | null = null;

/** Show the file picker (from a click: browsers only open it then). */
export function openFilePicker(): void {
  if (!pickerInput) return;
  pickerInput.value = '';
  pickerInput.click();
}

type Message =
  | { kind: 'desktop'; name: string; format: DesktopOnlyFormat }
  | { kind: 'unknown'; name: string }
  | { kind: 'failed'; name: string; error: string };

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

export function FileOpener() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  // Parts the opened layout defines differently from the server, waiting on the user.
  const [asking, setAsking] = useState<{ differing: PartDifference[]; answer: (c: PartChoice[] | null) => void } | null>(null);

  useEffect(() => {
    pickerInput = input.current;
    return () => {
      pickerInput = null;
    };
  }, []);

  const loadCatalog = async () =>
    (await qc.fetchQuery({ queryKey: ['parts-catalog'], queryFn: api.parts.catalog, staleTime: 5 * 60 * 1000 })).parts;

  async function open(all: readonly File[]) {
    const sorted = sortFiles(all);
    if (sorted.kind === 'none') return;
    if (sorted.kind === 'desktop') return setMessage({ kind: 'desktop', name: sorted.file.name, format: sorted.format });
    if (sorted.kind === 'unknown') return setMessage({ kind: 'unknown', name: sorted.file.name });
    const files = sorted.files;
    const first = files[0]!.name;
    setBusy(first);
    try {
      let layouts: DroppedLayout[];
      try {
        layouts = await layoutsFromFiles(files, catalogMapConverter(loadCatalog));
      } catch (err) {
        setMessage({ kind: 'failed', name: first, error: (err as Error).message });
        return;
      }
      if (layouts.length === 0) {
        // A .zip without a layout in it, or a sidecar without its .bbm.
        setMessage({ kind: 'unknown', name: first });
        return;
      }
      const ask = (differing: PartDifference[]) => new Promise<PartChoice[] | null>((answer) => setAsking({ differing, answer }));
      for (const l of layouts) {
        try {
          // A cut-off or damaged .bbm is refused here, saying where, before
          // the server sees it: it used to open with only part of its parts.
          const { readBbm } = await import('@cld/bbm/browser');
          readBbm(l.bbm);
          // The parts a .bld-layout carries that this server lacks become the user's custom parts;
          // the ones it defines differently are asked about first.
          const parts = await takeLayoutParts(l.parts, l.bbm, loadCatalog, ask);
          // The browser keeps the catalog for 60 s: fetch past that so the editor sees the new parts.
          if (parts.changed) await qc.fetchQuery({ queryKey: ['parts-catalog'], queryFn: api.parts.catalog, staleTime: 0 });
          const warnings = [...(l.warnings ?? []), ...parts.notes];
          const created = await api.layouts.create({
            // Named after the file, as the New layout dialog does (the
            // .bbm's event is often BlueBrick's "Unknown Event").
            title: titleFromFileName(l.name),
            bbm: parts.bbm,
            ...(l.sidecar !== undefined ? { sidecar: l.sidecar } : {}),
            ...(l.background ? { backgroundImage: l.background } : {}),
          });
          void qc.invalidateQueries({ queryKey: ['layouts'] });
          const state: OpenedMapState = { openedFile: l.name, ...(warnings.length ? { openWarnings: warnings } : {}) };
          navigate(`/editor/${created.id}`, { state });
        } catch (err) {
          setMessage({ kind: 'failed', name: l.name, error: (err as Error).message });
        }
      }
    } finally {
      setBusy(null);
    }
  }
  // The window listeners call the latest open().
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });

  useEffect(() => {
    // dragenter / dragleave fire for every element crossed: count them.
    let depth = 0;
    function onDragEnter(e: DragEvent) {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    }
    function onDragLeave(e: DragEvent) {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    }
    function onDragOver(e: DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }
    function onDrop(e: DragEvent) {
      depth = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      // Never let the browser leave the page to show the file.
      e.preventDefault();
      void openRef.current(files);
    }
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={OPEN_PICKER_ACCEPT}
        aria-label="Open a file"
        data-testid="open-file-input"
        className="hidden"
        onChange={(e) => void open(Array.from(e.target.files ?? []))}
      />
      {dragging && (
        <div
          data-testid="drop-overlay"
          className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
        >
          <div className="max-w-md rounded-section border-2 border-dashed border-accent bg-panel px-6 py-8 text-center shadow-pop">
            <p className="font-display text-xl font-bold text-ink">Drop a layout file to open it</p>
            <p className="mt-2 text-sm text-muted">{OPEN_FORMATS_LINE}</p>
          </div>
        </div>
      )}
      {/* Not over the question about parts that differ. */}
      {busy && !asking && (
        <div role="status" className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4">
          <div className="flex items-center gap-3 rounded-section border border-line bg-panel px-5 py-4 text-sm text-ink shadow-pop">
            <span aria-hidden className="size-4 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            <span className="break-all">Opening {busy}…</span>
          </div>
        </div>
      )}
      {message && <OpenMessage message={message} onClose={() => setMessage(null)} />}
      {asking && (
        <PartDifferencesDialog
          differences={asking.differing}
          onDone={(choices) => {
            setAsking(null);
            asking.answer(choices);
          }}
        />
      )}
    </>
  );
}

function OpenMessage({ message, onClose }: { message: Message; onClose: () => void }) {
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => ok.current?.focus(), []);
  let title: string;
  let body: ReactNode;
  if (message.kind === 'desktop') {
    title = 'Open this in the desktop app';
    body = <DesktopOnlySteps name={message.name} format={message.format} />;
  } else if (message.kind === 'unknown') {
    title = 'This isn’t a layout file';
    body = (
      <>
        <p>
          <span className="font-semibold text-ink break-all">{message.name}</span> isn’t something the website can open.
        </p>
        <p className="flex items-start gap-1">
          <span>{OPEN_FORMATS_LINE}</span> <HelpButton helpKey="open.formats" />
        </p>
      </>
    );
  } else {
    title = 'The file couldn’t be opened';
    body = (
      <>
        <p>
          <span className="font-semibold text-ink break-all">{message.name}</span>: {message.error}
        </p>
        <p>If it opens in the desktop app, choose File › Save to Server… there to bring it here.</p>
      </>
    );
  }
  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="open-message"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-section border border-line bg-panel p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] text-sm text-ink shadow-pop sm:max-w-md sm:rounded-section sm:pb-5"
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        <div className="mt-2 space-y-2 text-muted">{body}</div>
        <div className="mt-4 flex justify-end">
          <button
            ref={ok}
            type="button"
            onClick={onClose}
            className="tap-target rounded-lg bg-accent px-4 py-2 font-semibold text-accent-ink hover:bg-accent-hover"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
