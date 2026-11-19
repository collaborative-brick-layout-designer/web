// Import an LDraw, BrickLink Studio or LDD model on the website
// (docs/model-import.md). The server runs the desktop app's own importer, so
// the preview offers what the desktop's Tools › Import preview offers, in
// its words: turn it, line it up with the stud grid, drop connection points,
// name it and say who built it. An .ldr or .mpd can also have its parts
// placed one by one, as the desktop's File › Open does.
//
//   upload (progress) → waiting / reading (place in line) → preview
//   → making it → what came in, with a way to fix what's missing
// Cancel works at every step and deletes the file on the server.
//
// Into the layout open in the editor, the server only makes the part (or
// reads the parts) and the editor puts them down itself (`into.place`), so
// one Undo takes the whole import back. `purpose: 'part'` (Custom parts and
// the Parts panel) only makes a custom part: saved to you or a club, and,
// from the editor, put down here too when asked.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { HelpButton } from '../help/HelpButton';
import { defaultSaveTo, readOwnerFilter, type OwnerFilter } from '../owners/owners';
import { SaveToPicker } from '../owners/OwnerControls';
import { useTours } from '../tours/TourProvider';
import { DESKTOP_URL } from '../projectLinks';
import { importApi, importErrorText, uploadModel, type ConvertChoices, type ImportJob, type ImportResult, type ImportTarget, type ToPlace } from './importApi';
import { partToPlace } from './placeImport';
import { aligned, connectionTypeName, rotated, type Align } from './previewMath';

export interface ImportInto {
  layoutId: string;
  /** The parts sheets, the active one first. */
  sheets: { id: string; name: string }[];
  /** Where new parts go: the middle of the view, in studs. */
  at: { x: number; y: number };
  /**
   * Put the parts down as the editor's own change (one Undo step, synced to
   * everyone in the layout): import/placeImport.ts. Returns the new ids.
   */
  place: (sheetId: string, toPlace: ToPlace) => string[];
}

interface Props {
  file: File;
  /** From the editor: put it in this layout (or, by choice, a new one). */
  into?: ImportInto | undefined;
  /** Whether the person may change the site's libraries (for "fix the misses"). */
  isAdmin?: boolean;
  onClose: () => void;
  /** The import finished: open the new layout, or select what came in. */
  onDone?: (result: ImportResult) => void;
  /** 'part': only make a custom part (Custom parts, the Parts panel), saved to you or a club. */
  purpose?: 'any' | 'part';
  /** Home's owner filter, for where the part is saved to (purpose 'part'). */
  filter?: OwnerFilter | undefined;
}

type Where = 'here' | 'new' | 'library';

/** The upload under way for each picked file (see "Upload once" below). */
const uploads = new WeakMap<File, { ac: AbortController; job: Promise<ImportJob>; cancelled?: boolean }>();
const sentTo = new WeakMap<File, (sent: number) => void>();

const STEPS = [
  { label: '½ stud', value: 0.5 },
  { label: '¼ stud', value: 0.25 },
  { label: '⅛ stud', value: 0.125 },
  { label: '1/16 stud', value: 0.0625 },
];

const btn = 'tap-target rounded-lg border border-line bg-panel px-3 py-1.5 text-sm text-ink hover:bg-soft disabled:opacity-50';
const primary = 'tap-target rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50';
const field = 'w-full rounded-lg border border-line bg-panel px-2 py-1.5 text-sm text-ink';

export function ImportDialog({ file, into, isAdmin = false, onClose, onDone, purpose = 'any', filter }: Props) {
  const partOnly = purpose === 'part';
  const qc = useQueryClient();
  const tours = useTours();
  const [sent, setSent] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobId = useRef<string | null>(null);
  const finished = useRef(false);
  const upload = useRef<AbortController | null>(null);

  // Preview choices.
  const [mode, setMode] = useState<'part' | 'parts'>('part');
  const [turns, setTurns] = useState(0);
  const [align, setAlign] = useState<Align>('');
  const [nudge, setNudge] = useState({ x: 0, y: 0 });
  const [step, setStep] = useState(0.25);
  const [dropped, setDropped] = useState<Set<number>>(new Set());
  const [name, setName] = useState('');
  const [category, setCategory] = useState('Imported');
  const [designer, setDesigner] = useState('');
  const [designerUrl, setDesignerUrl] = useState('');
  const [where, setWhere] = useState<Where>(partOnly ? 'library' : into ? 'here' : 'new');
  const [sheetId, setSheetId] = useState(into?.sheets[0]?.id ?? '');
  const [title, setTitle] = useState('');
  // Purpose 'part': who it's saved to ('' = you), as Upload part asks.
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, enabled: partOnly });
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: api.orgs.list, enabled: partOnly });
  const [saveTo, setSaveTo] = useState(() => (partOnly ? defaultSaveTo(filter ?? readOwnerFilter(me.data?.user?.id)) : ''));
  // A remembered club you've since left: save to you.
  useEffect(() => {
    if (saveTo && orgs.data && !orgs.data.orgs.some((o) => o.slug === saveTo)) setSaveTo('');
  }, [orgs.data, saveTo]);
  // Where the editor puts it down once it's made (asked when Make was clicked).
  const placing = useRef<{ sheetId: string } | null>(null);
  const [placed, setPlaced] = useState<ImportResult | null>(null);
  const [placeError, setPlaceError] = useState<string | null>(null);

  // Upload once per file: React's development double effect must not send it
  // twice (the first copy became a job nobody closed, and three of them
  // refused the next import). Close aborts it; leaving any other way cancels
  // the job once it's known.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    let sending = uploads.get(file);
    if (!sending) {
      const ac = new AbortController();
      sending = { ac, job: uploadModel(file, (n) => sentTo.get(file)?.(n), ac.signal) };
      uploads.set(file, sending);
    }
    sentTo.set(file, setSent);
    upload.current = sending.ac;
    const s = sending;
    s.job
      .then((j) => {
        if (!mounted.current) {
          // Gone before the upload finished: nothing stays on the server (once).
          if (!s.cancelled) void importApi.cancel(j.id);
          s.cancelled = true;
          return;
        }
        if (jobId.current === j.id) return;
        jobId.current = j.id;
        setJob(j);
      })
      .catch((e: Error) => {
        if (mounted.current && e.name !== 'AbortError') setError(e.message);
      });
    return () => {
      mounted.current = false;
    };
  }, [file]);

  // Follow the job while the server works on it.
  useEffect(() => {
    if (!job || !['queued', 'analysing', 'converting'].includes(job.state)) return;
    const t = setTimeout(() => {
      importApi
        .job(job.id)
        .then(setJob)
        .catch((e: Error) => setError(e.message));
    }, 600);
    return () => clearTimeout(t);
  }, [job]);

  // The preview's starting values, once.
  const analysis = job?.analysis ?? null;
  // The preview shows once its fields hold the model's own values (no
  // frame with an empty name).
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!analysis || seeded) return;
    setSeeded(true);
    setName(analysis.suggestedName);
    setDesigner(analysis.designer);
    setTitle(analysis.suggestedName);
    if (!analysis.part && analysis.layout) setMode('parts');
  }, [analysis, seeded]);

  useEffect(() => {
    if (job?.state === 'done' && job.result && !finished.current) {
      finished.current = true;
      const result = job.result;
      void qc.invalidateQueries({ queryKey: ['custom-parts'] });
      void qc.invalidateQueries({ queryKey: ['layouts'] });
      // Fetched past the browser's cache, so the new part draws as soon as it's put down.
      const catalog = qc.fetchQuery({ queryKey: ['parts-catalog'], queryFn: api.parts.catalog, staleTime: 0 }).catch(() => undefined);
      const at = placing.current;
      const toPlace = result.toPlace ?? (at && result.part ? partToPlace(result) : null);
      if (!at || !into || !toPlace) {
        setPlaced(result);
        return;
      }
      void (async () => {
        if (result.part) await catalog;
        // Closed meanwhile: put nothing down (the part, if any, stays saved).
        if (!mounted.current) return;
        const ids = into.place(at.sheetId, toPlace);
        if (ids.length === 0) setPlaceError(result.part ? 'This layout has no parts sheet to put it on. Add one, then place the part from the Parts panel.' : 'This layout has no parts sheet to put them on. Add one, then import the model again.');
        setPlaced({ ...result, toPlace: null, placed: ids.length, brickIds: ids });
        // The server needn't keep the parts any longer.
        void importApi.cancel(job.id);
      })();
    }
  }, [job, qc, into]);

  // Leaving before it's done cancels it: nothing stays on the server.
  const close = useCallback(() => {
    upload.current?.abort();
    uploads.delete(file);
    if (jobId.current && !finished.current) void importApi.cancel(jobId.current);
    // Once: the unmount below must not ask again (a 404).
    jobId.current = null;
    onClose();
  }, [onClose, file]);
  useEffect(
    () => () => {
      if (jobId.current && !finished.current) void importApi.cancel(jobId.current);
    },
    [],
  );

  const part = analysis?.part ?? null;
  const frame = useMemo(() => (part ? aligned(rotated(part, turns), align, nudge) : null), [part, turns, align, nudge]);

  async function make() {
    if (!job) return;
    setError(null);
    const target: ImportTarget = partOnly
      ? { kind: 'library', ...(saveTo ? { orgSlug: saveTo } : {}) }
      : into && where === 'here'
        ? { kind: 'layout', layoutId: into.layoutId, sheetId, at: into.at, clientPlaces: true }
        : { kind: 'new', title: title.trim() || name.trim() };
    placing.current = into && where === 'here' ? { sheetId } : null;
    const choices: ConvertChoices = {
      mode: partOnly ? 'part' : mode,
      quarterTurns: turns,
      align,
      nudge: [nudge.x, nudge.y],
      drop: [...dropped],
      name: name.trim(),
      designer: designer.trim(),
      designerUrl: designerUrl.trim(),
      category: category.trim(),
      target,
    };
    try {
      setJob(await importApi.convert(job.id, choices));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Done once the editor has put it down (or there was nothing to put down).
  const state = error ? 'error' : !job ? 'uploading' : job.state === 'done' && !placed ? 'converting' : job.state;
  const savedTo = partOnly && saveTo ? (orgs.data?.orgs.find((o) => o.slug === saveTo)?.name ?? null) : null;
  const working = state === 'uploading' || state === 'queued' || state === 'analysing' || state === 'converting';

  return (
    <div
      className="fixed inset-0 z-[75] flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !working) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import a model"
        data-testid="import-dialog"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
        }}
        className="flex max-h-[95vh] w-full flex-col overflow-hidden rounded-t-section border border-line bg-panel text-sm text-ink shadow-pop sm:max-w-4xl sm:rounded-section"
      >
        <header className="flex items-center gap-2 border-b border-line px-5 py-3">
          <h2 className="text-lg font-semibold">
            {analysis ? `Preview: ${analysis.kindLabel}` : partOnly ? 'Make a custom part from a model' : 'Import a model'}
          </h2>
          <HelpButton helpKey="import.model" />
          {state === 'ready' && (
            <button type="button" className="text-sm font-semibold text-accent-text hover:underline" onClick={() => tours.startTour('import')}>
              Show me around
            </button>
          )}
          <span className="ml-auto truncate text-muted" title={file.name}>
            {file.name}
          </span>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {state === 'uploading' && (
            <Progress label={`Sending ${file.name}…`} value={sent} testId="import-uploading" />
          )}
          {(state === 'queued' || state === 'analysing') && job?.step === 'analyse' && (
            <Progress
              label={state === 'queued' && job.position > 0 ? `Waiting for a turn (${job.position} ahead of you in line)…` : 'Reading the model and drawing it, as the desktop app does…'}
              testId="import-reading"
            />
          )}
          {(state === 'queued' || state === 'converting') && job?.step === 'convert' && (
            <Progress label={partOnly || mode === 'part' ? 'Making the custom part…' : 'Placing the parts…'} testId="import-making" />
          )}
          {state === 'error' && (
            <div data-testid="import-error" className="space-y-2">
              <p className="font-semibold">The model couldn’t be imported.</p>
              <p className="text-muted">{error}</p>
              <DesktopHint />
            </div>
          )}
          {state === 'failed' && job?.error && (
            <div data-testid="import-error" className="space-y-2">
              <p className="font-semibold">The model couldn’t be imported.</p>
              <p className="text-muted">{importErrorText(job.error.code, job.error.message)}</p>
              <DesktopHint />
            </div>
          )}
          {state === 'ready' && analysis && seeded && (
            <div className="grid gap-5 md:grid-cols-[3fr_2fr]" data-testid="import-preview">
              <div className="space-y-3">
                {!partOnly && analysis.part && analysis.layout && (
                  <fieldset className="space-y-1 rounded-lg border border-line p-3">
                    <legend className="flex items-center gap-1 px-1 font-semibold">
                      Bring it in as <HelpButton helpKey="import.mode" />
                    </legend>
                    <label className="flex items-center gap-2">
                      <input type="radio" name="import-mode" checked={mode === 'part'} onChange={() => setMode('part')} />
                      One custom part (Tools › Import in the desktop app)
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="radio" name="import-mode" checked={mode === 'parts'} onChange={() => setMode('parts')} />
                      Its parts, one by one ({analysis.layout.bricks} parts on {analysis.layout.sheets} sheets, as File › Open does)
                    </label>
                  </fieldset>
                )}
                {mode === 'part' && part && frame ? (
                  <>
                    <PreviewPicture src={part.preview} frame={frame} turns={turns} pxPerStud={part.pxPerStud} dropped={dropped} />
                    <p data-testid="import-size" className="text-muted">
                      {frame.widthStuds} × {frame.heightStuds} studs, {frame.connections.length - dropped.size} connection point
                      {frame.connections.length - dropped.size === 1 ? '' : 's'}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <button type="button" className={btn} title="Turn the part 90° left" onClick={() => setTurns((t) => (t + 3) % 4)}>
                        Turn ⟲
                      </button>
                      <button type="button" className={btn} title="Turn the part 90° right" onClick={() => setTurns((t) => (t + 1) % 4)}>
                        Turn ⟳
                      </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1">
                        Align to:
                        <select
                          aria-label="Align to"
                          className={field + ' w-auto'}
                          value={align}
                          title="Which studs go on the grid: Automatic puts the flat bottom plates on it, else centers the model."
                          onChange={(e) => setAlign(e.target.value as Align)}
                        >
                          <option value="">Automatic</option>
                          <option value="bottom">Bottom plates</option>
                          <option value="box">Bounding box</option>
                        </select>
                      </label>
                      <HelpButton helpKey="import.align" />
                      <label className="flex items-center gap-1" title="Shift the model against the stud grid by this much per click.">
                        Move by
                        <select aria-label="Move by" className={field + ' w-auto'} value={step} onChange={(e) => setStep(Number(e.target.value))}>
                          {STEPS.map((s) => (
                            <option key={s.value} value={s.value}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {(
                        [
                          ['Left', -1, 0],
                          ['Right', 1, 0],
                          ['Up', 0, -1],
                          ['Down', 0, 1],
                        ] as const
                      ).map(([label, x, y]) => (
                        <button
                          key={label}
                          type="button"
                          className={btn}
                          title={`Move the model ${label.toLowerCase()} against the grid`}
                          onClick={() => setNudge((n) => ({ x: n.x + x * step, y: n.y + y * step }))}
                        >
                          {label}
                        </button>
                      ))}
                      <button
                        type="button"
                        className={btn}
                        title="Back to Automatic, with no nudge"
                        onClick={() => {
                          setAlign('');
                          setNudge({ x: 0, y: 0 });
                        }}
                      >
                        Reset
                      </button>
                    </div>
                  </>
                ) : mode === 'parts' && analysis.layout ? (
                  <div className="rounded-lg border border-line p-3" data-testid="import-layout-summary">
                    <p>
                      {analysis.layout.bricks} parts on {analysis.layout.sheets} sheet{analysis.layout.sheets === 1 ? '' : 's'}, placed as the desktop
                      app’s File › Open places them.
                    </p>
                    <Warnings list={analysis.layout.warnings} />
                  </div>
                ) : (
                  <p className="text-muted">{analysis.partError}</p>
                )}
              </div>

              <div className="space-y-3">
                {mode === 'part' && part && frame && (
                  <>
                    <div>
                      <p className="flex items-center gap-1 font-semibold">
                        Connection points (uncheck to drop): <HelpButton helpKey="import.connections" />
                      </p>
                      <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-line p-2" data-testid="import-connections">
                        {frame.connections.length === 0 && <li className="text-muted">None — the part won’t snap to track.</li>}
                        {frame.connections.map((c, i) => (
                          <li key={i}>
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={!dropped.has(i)}
                                onChange={(e) =>
                                  setDropped((d) => {
                                    const n = new Set(d);
                                    if (e.target.checked) n.delete(i);
                                    else n.add(i);
                                    return n;
                                  })
                                }
                              />
                              {connectionTypeName(c.type)} at ({c.x.toFixed(2)}, {c.y.toFixed(2)}), facing {c.angle.toFixed(1)}°
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <Stats stats={part.stats} />
                    <Warnings list={part.warnings} />
                    <label className="block">
                      Save as:
                      <input aria-label="Save as" className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
                    </label>
                    <label className="block" title="Parts panel category (a folder of your custom parts)">
                      Category:
                      <input aria-label="Category" className={field} value={category} onChange={(e) => setCategory(e.target.value)} maxLength={60} />
                    </label>
                    <label className="block" title="Shown with the part wherever it's used, here and on a server">
                      Designed by:
                      <input
                        aria-label="Designed by"
                        className={field}
                        placeholder="Who built this model (optional)"
                        value={designer}
                        onChange={(e) => setDesigner(e.target.value)}
                        maxLength={200}
                      />
                    </label>
                    <label className="block">
                      Link:
                      <input
                        aria-label="Link"
                        className={field}
                        placeholder="A link to their page or the model (optional)"
                        value={designerUrl}
                        onChange={(e) => setDesignerUrl(e.target.value)}
                        maxLength={500}
                      />
                    </label>
                  </>
                )}
                {partOnly ? (
                  <fieldset className="space-y-2 rounded-lg border border-line p-3" data-testid="import-save-to">
                    <legend className="flex items-center gap-1 px-1 font-semibold">
                      Save it <HelpButton helpKey="import.saveTo" />
                    </legend>
                    <SaveToPicker value={saveTo} onChange={setSaveTo} orgs={orgs.data?.orgs} kind="part" />
                    {into && (
                      <>
                        <label className="flex items-center gap-2">
                          <input type="radio" name="import-where" checked={where === 'library'} onChange={() => setWhere('library')} />
                          Save to my parts
                        </label>
                        <label className="flex flex-wrap items-center gap-2">
                          <input type="radio" name="import-where" checked={where === 'here'} onChange={() => setWhere('here')} />
                          Save and place it here, on
                          <select aria-label="Sheet" className={field + ' w-auto'} value={sheetId} disabled={where !== 'here'} onChange={(e) => setSheetId(e.target.value)}>
                            {into.sheets.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name || 'Sheet'}
                              </option>
                            ))}
                          </select>
                        </label>
                      </>
                    )}
                  </fieldset>
                ) : (
                  <fieldset className="space-y-1 rounded-lg border border-line p-3">
                    <legend className="flex items-center gap-1 px-1 font-semibold">
                      Put it in <HelpButton helpKey="import.where" />
                    </legend>
                    {into && (
                      <label className="flex items-center gap-2">
                        <input type="radio" name="import-where" checked={where === 'here'} onChange={() => setWhere('here')} />
                        This layout, on
                        <select aria-label="Sheet" className={field + ' w-auto'} value={sheetId} disabled={where !== 'here'} onChange={(e) => setSheetId(e.target.value)}>
                          {into.sheets.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name || 'Sheet'}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className="flex items-center gap-2">
                      <input type="radio" name="import-where" checked={where === 'new'} onChange={() => setWhere('new')} />A new layout
                    </label>
                    {where === 'new' && (
                      <input aria-label="New layout’s name" className={field} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
                    )}
                  </fieldset>
                )}
              </div>
            </div>
          )}
          {state === 'done' && placed && (
            <Summary result={placed} isAdmin={isAdmin} newLayout={placed.newLayout} savedOnly={!placed.newLayout && placed.placed === 0 && !placeError} savedTo={savedTo} placeError={placeError} />
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
          {state === 'done' && placed ? (
            <>
              {placed.newLayout ? (
                <Link to={`/editor/${placed.layoutId}`} className={primary} onClick={() => onDone?.(placed)} data-testid="import-open-layout">
                  Open the layout
                </Link>
              ) : (
                <button type="button" className={primary} onClick={() => (onDone ? onDone(placed) : onClose())}>
                  Done
                </button>
              )}
            </>
          ) : (
            <>
              <button type="button" className={btn} onClick={close} data-testid="import-cancel">
                Cancel
              </button>
              {state === 'ready' && seeded && (
                <button
                  type="button"
                  className={primary}
                  data-testid="import-make"
                  disabled={((partOnly || mode === 'part') && (!part || !name.trim() || !category.trim())) || (!partOnly && mode === 'parts' && !analysis?.layout)}
                  onClick={() => void make()}
                >
                  {partOnly && where === 'here' ? 'Save and place it' : partOnly || mode === 'part' ? 'Save as Custom Part' : 'Place the parts'}
                </button>
              )}
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function Progress({ label, value, testId }: { label: string; value?: number; testId: string }) {
  return (
    <div role="status" data-testid={testId} className="flex flex-col items-center gap-3 py-10 text-center">
      {value === undefined ? (
        <span aria-hidden className="size-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      ) : (
        <progress className="w-64" max={1} value={value} aria-label="Sent" />
      )}
      <p>{label}</p>
    </div>
  );
}

function Stats({ stats }: { stats: { ldrawResolved: number; lddRendered: number; unresolved: number } }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3" data-testid="import-stats">
      {stats.ldrawResolved > 0 && (
        <>
          <dt>Parts rendered:</dt>
          <dd>{stats.ldrawResolved}</dd>
        </>
      )}
      {stats.lddRendered > 0 && (
        <>
          <dt>LDD parts rendered:</dt>
          <dd>{stats.lddRendered}</dd>
        </>
      )}
      {stats.unresolved > 0 && (
        <>
          <dt>Parts missing:</dt>
          <dd>{stats.unresolved}</dd>
        </>
      )}
    </dl>
  );
}

/**
 * The importer's warnings are the desktop app's words; where they send
 * people to the desktop's settings, the site's libraries are meant here.
 */
export function siteWords(warning: string): string {
  return warning.replace('Settings › Bringing in models', 'this site’s libraries (Admin › Model import)');
}

function Warnings({ list }: { list: string[] }) {
  if (list.length === 0) return null;
  return (
    <div>
      <p className="font-semibold">
        {list.length} warning{list.length === 1 ? '' : 's'}:
      </p>
      <ul className="mt-1 max-h-28 list-disc space-y-1 overflow-y-auto pl-5 text-muted" data-testid="import-warnings">
        {list.map((w, i) => (
          <li key={i}>{siteWords(w)}</li>
        ))}
      </ul>
    </div>
  );
}

function PreviewPicture({
  src,
  frame,
  turns,
  pxPerStud,
  dropped,
}: {
  src: string;
  frame: ReturnType<typeof aligned>;
  turns: number;
  pxPerStud: number;
  dropped: Set<number>;
}) {
  const s = Math.max(1, pxPerStud);
  const W = frame.widthStuds * s;
  const H = frame.heightStuds * s;
  // The picture as drawn (before turning) is imageStuds turned back.
  const odd = turns % 2 === 1;
  const iw = (odd ? frame.imageStuds.height : frame.imageStuds.width) * s;
  const ih = (odd ? frame.imageStuds.width : frame.imageStuds.height) * s;
  const turn =
    turns === 1 ? `translate(${ih} 0) rotate(90)` : turns === 2 ? `translate(${iw} ${ih}) rotate(180)` : turns === 3 ? `translate(0 ${iw}) rotate(270)` : '';
  const grid: React.ReactNode[] = [];
  for (let i = 0; i <= frame.widthStuds; i++) grid.push(<line key={`x${i}`} x1={i * s} y1={0} x2={i * s} y2={H} />);
  for (let j = 0; j <= frame.heightStuds; j++) grid.push(<line key={`y${j}`} x1={0} y1={j * s} x2={W} y2={j * s} />);
  return (
    <div
      className="flex max-h-[50vh] justify-center overflow-auto rounded-lg border border-line"
      // A checkerboard behind the picture, so its see-through parts show (as the desktop's preview).
      style={{ background: 'repeating-conic-gradient(#dcdcdc 0% 25%, #ffffff 0% 50%) 0 0 / 16px 16px' }}
      data-testid="import-picture"
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto max-h-[50vh] w-full" role="img" aria-label="The part, over the stud grid">
        <g transform={`translate(${frame.imageAt.x * s} ${frame.imageAt.y * s})`}>
          <image href={src} width={iw} height={ih} transform={turn} preserveAspectRatio="none" />
        </g>
        <g stroke="rgba(0,120,255,0.35)" strokeWidth={1} vectorEffect="non-scaling-stroke">
          {grid}
        </g>
        {frame.connections.map((c, i) => {
          const x = (c.x + frame.widthStuds / 2) * s;
          const y = (c.y + frame.heightStuds / 2) * s;
          const a = (c.angle * Math.PI) / 180;
          const on = !dropped.has(i);
          return (
            <g key={i} stroke={on ? 'rgb(220,30,30)' : 'rgb(140,140,140)'} strokeWidth={2} fill="none" strokeDasharray={on ? undefined : '4 3'} vectorEffect="non-scaling-stroke">
              <circle cx={x} cy={y} r={0.6 * s} />
              <line x1={x} y1={y} x2={x + Math.cos(a) * 2 * s} y2={y + Math.sin(a) * 2 * s} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Summary({
  result,
  isAdmin,
  newLayout,
  savedOnly,
  savedTo,
  placeError,
}: {
  result: ImportResult;
  isAdmin: boolean;
  newLayout: boolean;
  /** Only saved to the library: nothing was placed. */
  savedOnly: boolean;
  /** The club it was saved to; null for you. */
  savedTo: string | null;
  placeError: string | null;
}) {
  const missing = result.stats?.unresolved ?? 0;
  const saved = savedTo ? `saved it to ${savedTo}’s custom parts` : 'saved it to your custom parts';
  const where = newLayout ? 'put it in a new layout' : result.placed > 0 ? (savedTo ? `${saved} and put it in the middle of your view` : 'put it in the middle of your view') : saved;
  return (
    <div className="space-y-3" data-testid="import-summary">
      {result.mode === 'part' && result.part ? (
        <p>
          Made the custom part <span className="font-semibold">“{result.part.displayName}”</span> ({result.widthStuds} × {result.heightStuds} studs,{' '}
          {result.connections} connection point{result.connections === 1 ? '' : 's'}) and {where}.
        </p>
      ) : (
        <p>
          Placed <span className="font-semibold">{result.placed}</span> part{result.placed === 1 ? '' : 's'} {newLayout ? 'in a new layout' : 'in this layout'}.
        </p>
      )}
      {savedOnly && <p className="text-muted">It’s in your Parts panel and under Custom parts, ready to place.</p>}
      {!newLayout && !savedOnly && result.placed > 0 && (
        <p className="text-muted" data-testid="import-undo-hint">
          Changed your mind? Edit › Undo takes the whole import back in one step.
        </p>
      )}
      {placeError && (
        <p className="text-danger" role="alert" data-testid="import-place-error">
          {placeError}
        </p>
      )}
      {result.stats && <Stats stats={result.stats} />}
      {missing > 0 && (
        <div className="rounded-lg border border-line bg-soft p-3" data-testid="import-misses">
          <p className="flex items-center gap-1 font-semibold">
            {missing} part{missing === 1 ? ' was' : 's were'} missing from the picture <HelpButton helpKey="import.missing" />
          </p>
          <p className="text-muted">
            {isAdmin ? (
              <>
                A newer library may have them: <Link to="/admin?tab=imports" className="font-semibold text-accent-text hover:underline">Admin › Model import</Link>.
              </>
            ) : (
              <>A newer library on this site may have them: ask your site’s admin, or import it in the desktop app with your own libraries.</>
            )}
          </p>
        </div>
      )}
      <Warnings list={result.warnings} />
    </div>
  );
}

function DesktopHint() {
  return (
    <p className="text-muted">
      The{' '}
      <a href={DESKTOP_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent-text hover:underline">
        desktop app
      </a>{' '}
      imports models with your own libraries, and can send the result here.
    </p>
  );
}
