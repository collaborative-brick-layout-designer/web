// Download As — the web side of desktop MainWindow::onSaveAs and Export as
// BlueBrick Map (MainWindowFileIO.cpp): the layout as a .bld-layout (the
// whole layout in one file), .bbm, LDraw (.ldr / .mpd), TrackDesigner (.tdl)
// or 4DBrix (.ncp). A .bbm leaves out what BlueBrick can't hold, and says
// what; the other formats show the desktop's warning, with "Don't show
// this again".

import { noticeDownloaded } from './editorStore';
import { useState } from 'react';
import type { BbmMap } from '@cld/model';
import type { Sidecar } from '@cld/bbm';
import type { PartWire } from '../api';
import { LOSSY_FORMAT_WARNING, MAP_FORMATS, mapDownload, type MapFormat } from '../mapFormats';
import { HelpButton } from '../help/HelpButton';
import { useEscape } from './useEscape';

const WARN_KEY = 'cld:warnNonBbmSave';

export function warnsOnNonBbmSave(): boolean {
  try {
    return localStorage.getItem(WARN_KEY) !== 'false';
  } catch {
    return true;
  }
}

function stopWarning() {
  try {
    localStorage.setItem(WARN_KEY, 'false');
  } catch {
    /* per-browser convenience only */
  }
}

function download(file: { filename: string; type: string; data: Uint8Array }) {
  const url = URL.createObjectURL(new Blob([file.data as BlobPart], { type: file.type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  noticeDownloaded(file.filename);
}

/** What a .bbm can't hold of this layout (desktop onExportBbm's list). */
export function blueBrickLeavesOut(sidecar: Sidecar | null | undefined): string[] {
  const lost: string[] = [];
  if (sidecar?.anchoredLabels?.length) lost.push('anchored labels');
  if (sidecar?.modules?.length) lost.push('modules');
  if (sidecar?.venue) lost.push('the venue');
  if (sidecar?.backgroundImage) lost.push('the background image');
  if (sidecar?.switchStates && Object.keys(sidecar.switchStates).length > 0) lost.push('switch settings');
  if (sidecar?.routes?.length) lost.push('routes');
  if (sidecar?.trains?.length) lost.push('trains');
  if (sidecar?.rollingStock?.length) lost.push('rolling stock');
  if (sidecar?.layoutPlaces?.length || sidecar?.modules?.some((m) => m.places?.length)) lost.push('places');
  if (sidecar?.waybills?.length) lost.push('waybills');
  if (sidecar?.opsJobs?.length) lost.push('jobs');
  if (sidecar?.trainScale !== undefined) lost.push('the train scale');
  return lost;
}

interface Props {
  map: BbmMap;
  parts: readonly PartWire[];
  title: string;
  /** The .bld-layout download, as File → Download Layout does. */
  onDownloadLayout: () => void;
  /** The .bbm alone, for BlueBrick. */
  onDownloadBbm: () => void;
  /** blueBrickLeavesOut for this layout. */
  blueBrickLeavesOut: string[];
  onClose: () => void;
}

export function DownloadAsDialog({ map, parts, title, onDownloadLayout, onDownloadBbm, blueBrickLeavesOut: lost, onClose }: Props) {
  useEscape(onClose);
  const [format, setFormat] = useState<MapFormat | 'bbm' | 'layout'>('layout');
  const [warn] = useState(warnsOnNonBbmSave);
  const [dontShow, setDontShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lossy = format !== 'bbm' && format !== 'layout';
  const bbmLeavesOut = format === 'bbm' && lost.length > 0;

  async function onDownload() {
    if (format === 'layout' || format === 'bbm') {
      (format === 'layout' ? onDownloadLayout : onDownloadBbm)();
      onClose();
      return;
    }
    if (warn && dontShow) stopWarning();
    setBusy(true);
    setError(null);
    try {
      download(await mapDownload(map, parts, format, title));
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Download As" className="fixed inset-0 z-50 grid place-items-center bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-md rounded-lg border border-line bg-panel p-5 shadow-xl">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">Download As</h2>
          <HelpButton helpKey="download.formats" target="fieldset" />
        </div>
        <fieldset className="mt-4 space-y-1 text-sm">
          <legend className="sr-only">Format</legend>
          {[
            { format: 'layout' as const, label: 'Collaborative Brick Layout Designer layout (.bld-layout)', help: 'download.layout' as const },
            { format: 'bbm' as const, label: 'BlueBrick map (.bbm)', help: 'download.bbm' as const },
            ...MAP_FORMATS,
          ].map((f) => (
            <div key={f.format} className="flex items-center gap-2">
              <label className="flex items-center gap-2">
                <input type="radio" name="download-format" checked={format === f.format} onChange={() => setFormat(f.format)} />
                {f.label}
              </label>
              {'help' in f && <HelpButton helpKey={f.help} />}
            </div>
          ))}
        </fieldset>
        {lossy && warn && (
          <div className="mt-4 rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-xs text-amber-200">
            <p>{LOSSY_FORMAT_WARNING}</p>
            <label className="mt-2 flex items-center gap-2">
              <input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />
              Don&apos;t show this again
            </label>
          </div>
        )}
        {bbmLeavesOut && (
          <p className="mt-4 rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-xs text-amber-200">
            BlueBrick can&apos;t hold {lost.join(', ')}, so the .bbm leaves them out. Your layout keeps them.
          </p>
        )}
        {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-border px-3 py-1 text-sm hover:bg-soft">
            Cancel
          </button>
          <button onClick={() => void onDownload()} disabled={busy} className="rounded-lg bg-accent text-accent-ink px-3 py-1 text-sm hover:bg-accent-hover disabled:opacity-50">
            {lossy && warn ? 'Download anyway' : 'Download'}
          </button>
        </div>
      </div>
    </div>
  );
}
