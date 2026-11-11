// "Share picture": a picture of the layout, the whole thing or a saved
// view, straight to the phone's share sheet (or a download on a
// computer), or to the clipboard. Sensible defaults and no questions;
// "More options" opens the detailed Export Image dialog. Below it,
// "Export all views" makes one picture per saved view in a zip.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BbmMap } from '@cld/model';
import type { SavedView, Sidecar } from '@cld/bbm';
import type { ExportHandle } from './ExportImageDialog';
import { useEditorStore } from './editorStore';
import {
  EXPORT_VIEWS_SIZES,
  WHOLE_LAYOUT,
  loadExportViewsOptions,
  pictureFileName,
  pictureSize,
  shareScale,
  viewPicture,
  type PictureSpec,
} from './savedViews';
import { canCopyImages, canShareFiles, canvasToPng, copyPicture, downloadAllViews, shareOrDownload } from './sharePicture';
import { HelpButton } from '../help/HelpButton';

/** `screen` = what's on screen now; otherwise a saved view's id, or WHOLE_LAYOUT.id. */
export type PictureChoice = string;
export const SCREEN = 'screen';

/** The picture a choice makes now, or null when there's nothing to show. */
export function choicePicture(
  choice: PictureChoice,
  views: readonly SavedView[],
  map: BbmMap,
  sidecar: Sidecar | null,
  handle: ExportHandle | null,
): PictureSpec | null {
  if (choice === SCREEN) {
    const region = handle?.screenRegion?.() ?? null;
    if (!region) return null;
    const st = useEditorStore.getState();
    const f = st.viewFilter;
    return { region, sheets: f?.sheets ?? null, grid: f ? f.grid : st.showGrid, labels: f?.labels ?? true };
  }
  const view = views.find((v) => v.id === choice) ?? WHOLE_LAYOUT;
  return viewPicture(view, map, sidecar);
}

interface Props {
  layoutTitle: string;
  views: readonly SavedView[];
  map: BbmMap;
  sidecar: Sidecar | null;
  exportImageRef: React.MutableRefObject<ExportHandle | null>;
  /** The picture picked when it opens. */
  initialChoice?: PictureChoice;
  /** Phones use the share sheet and get a bottom sheet. */
  phone: boolean;
  onMoreOptions: () => void;
  onClose: () => void;
}

interface Made {
  choice: PictureChoice;
  blob: Blob;
  url: string;
  width: number;
  height: number;
}

export function SharePictureDialog({ layoutTitle, views, map, sidecar, exportImageRef, initialChoice, phone, onMoreOptions, onClose }: Props) {
  const [choice, setChoice] = useState<PictureChoice>(initialChoice ?? WHOLE_LAYOUT.id);
  const [made, setMade] = useState<Made | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maxSide, setMaxSide] = useState(() => loadExportViewsOptions().maxSide);
  const [exporting, setExporting] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<{ ok: boolean; text: string } | null>(null);
  const useShare = useMemo(() => phone && canShareFiles(), [phone]);
  const canCopy = useMemo(() => canCopyImages(), []);
  const token = useRef(0);

  const choices = [
    { id: WHOLE_LAYOUT.id, label: 'Whole layout' },
    { id: SCREEN, label: 'What’s on screen' },
    ...views.map((v) => ({ id: v.id, label: v.name || 'View' })),
  ];
  const nameOf = (c: PictureChoice) => choices.find((x) => x.id === c)?.label ?? 'Layout';

  // Make the picture as soon as it's picked, so Share works straight from
  // the tap (Safari only opens the share sheet right after one).
  useEffect(() => {
    const mine = ++token.current;
    setMessage(null);
    setError(null);
    setBusy(true);
    void (async () => {
      try {
        const handle = exportImageRef.current;
        const spec = choicePicture(choice, views, map, sidecar, handle);
        if (!spec || !handle?.renderPicture) throw new Error('There is nothing to show yet.');
        const canvas = await handle.renderPicture(spec, pictureSize(spec.region, shareScale(spec.region)));
        if (!canvas) throw new Error('The picture could not be made.');
        const blob = await canvasToPng(canvas);
        if (mine !== token.current) return;
        setMade((old) => {
          if (old) URL.revokeObjectURL(old.url);
          return { choice, blob, url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height };
        });
      } catch (e) {
        if (mine === token.current) setError((e as Error).message);
      } finally {
        if (mine === token.current) setBusy(false);
      }
    })();
    // Only a new choice makes a new picture; edits meanwhile wait for the next pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice]);
  useEffect(() => () => {
    token.current++;
    setMade((old) => {
      if (old) URL.revokeObjectURL(old.url);
      return null;
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ready = made && made.choice === choice && !busy ? made : null;
  const filename = pictureFileName(layoutTitle, nameOf(choice));

  const onShare = async () => {
    if (!ready) return;
    setError(null);
    const outcome = await shareOrDownload(ready.blob, filename, `${layoutTitle} – ${nameOf(choice)}`, useShare);
    setMessage(outcome === 'shared' ? 'Shared.' : outcome === 'downloaded' ? `Saved to your downloads as “${filename}”.` : null);
  };
  const onCopy = async () => {
    if (!ready) return;
    try {
      await copyPicture(ready.blob);
      setMessage('Copied. Paste it into a message or a document.');
    } catch {
      setError('This browser would not copy the picture. Use Download instead.');
    }
  };
  const onExportAll = async () => {
    setExporting('Making pictures…');
    setExportNote(null);
    try {
      const n = await downloadAllViews({
        title: layoutTitle,
        views,
        map,
        sidecar,
        handle: exportImageRef.current,
        maxSide,
        onProgress: (done, total) => setExporting(total > 1 ? `Making picture ${done + 1} of ${total}…` : 'Making the picture…'),
      });
      setExportNote(
        n > 0
          ? { ok: true, text: `Downloaded ${n} ${n === 1 ? 'picture' : 'pictures'} in a zip file. Look in your Downloads folder.` }
          : { ok: false, text: 'There is nothing to show yet.' },
      );
    } catch (e) {
      setExportNote({ ok: false, text: (e as Error).message });
    } finally {
      setExporting(null);
    }
  };

  const primary = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-control bg-accent px-4 text-base font-bold text-accent-ink hover:bg-accent-hover disabled:opacity-50';
  const secondary = 'inline-flex min-h-11 items-center justify-center rounded-control border border-line px-4 text-sm text-ink hover:bg-soft disabled:opacity-50';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-picture-title"
      data-bottom-sheet={phone ? '' : undefined}
      className={`fixed inset-0 z-50 flex bg-black/60 ${phone ? 'items-end' : 'items-center justify-center p-4'}`}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        data-testid="share-picture"
        className={`flex max-h-[92dvh] w-full flex-col overflow-y-auto border border-line bg-panel text-ink shadow-pop ${
          phone ? 'rounded-t-2xl px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3' : 'max-w-lg rounded-card p-5'
        }`}
      >
        {phone && <div aria-hidden className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-line" />}
        <div className="flex items-center gap-2">
          <h2 id="share-picture-title" className="font-display text-lg font-bold">Share a picture</h2>
          <HelpButton helpKey="share.picture" />
          <button type="button" aria-label="Close" onClick={onClose} className="ml-auto flex size-11 items-center justify-center rounded-control text-muted hover:bg-soft hover:text-ink">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        <fieldset className="mt-2">
          <legend className="mb-1 text-sm font-bold text-muted">Picture of</legend>
          <div className="flex flex-wrap gap-1.5">
            {choices.map((c) => (
              <label
                key={c.id}
                className={`inline-flex min-h-11 cursor-pointer items-center rounded-full border px-3.5 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
                  choice === c.id ? 'border-accent bg-accent text-accent-ink font-bold' : 'border-line hover:bg-soft'
                }`}
              >
                <input type="radio" name="picture-of" value={c.id} checked={choice === c.id} onChange={() => setChoice(c.id)} className="sr-only" />
                {c.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mt-3 flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-card border border-line bg-soft">
          {ready ? (
            <img src={ready.url} alt={`Picture of ${nameOf(choice)}`} className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-sm text-muted">{error ?? 'Making the picture…'}</span>
          )}
        </div>
        {ready && <p className="mt-1 text-xs text-muted">{ready.width} × {ready.height} pixels</p>}

        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={`${primary} flex-1`} disabled={!ready} onClick={() => void onShare()}>
            {useShare ? 'Share picture' : 'Download picture'}
          </button>
          {canCopy && (
            <button type="button" className={`${secondary} flex-1`} disabled={!ready} onClick={() => void onCopy()}>
              Copy picture
            </button>
          )}
        </div>
        <p role="status" className="mt-2 min-h-5 text-sm">
          {error && ready ? <span className="text-danger">{error}</span> : message}
        </p>

        <div className="mt-2 border-t border-line pt-3">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold">Export all views</h3>
            <HelpButton helpKey="share.exportAllViews" />
          </div>
          <p className="mt-0.5 text-sm text-muted">
            {views.length === 0
              ? 'No saved views yet, so this makes one picture of the whole layout, in a zip file.'
              : `${views.length === 1 ? 'A picture of your saved view' : `One picture of each of your ${views.length} saved views`}, in a zip file. Do it again after a change to get new pictures.`}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Picture size" className="inline-flex rounded-control bg-soft p-1">
              {EXPORT_VIEWS_SIZES.map((s) => (
                <button
                  key={s.maxSide}
                  type="button"
                  aria-pressed={maxSide === s.maxSide}
                  onClick={() => setMaxSide(s.maxSide)}
                  title={`Up to ${s.maxSide} pixels across`}
                  className={`min-h-9 rounded-control px-3 text-sm pointer-coarse:min-h-11 ${maxSide === s.maxSide ? 'bg-panel font-bold shadow-sm' : 'text-muted'}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <button type="button" className={secondary} disabled={exporting !== null} onClick={() => void onExportAll()}>
              {exporting ?? (views.length > 0 ? 'Export all views' : 'Export picture')}
            </button>
          </div>
          <p aria-live="polite" data-testid="export-note" className="mt-2 min-h-5 text-sm">
            {exportNote && <span className={exportNote.ok ? 'font-semibold text-ok' : 'text-danger'}>{exportNote.ok ? '✓ ' : ''}{exportNote.text}</span>}
          </p>
        </div>

        <div className="mt-3 flex justify-between gap-2 border-t border-line pt-3">
          <button type="button" className="min-h-11 px-1 text-sm font-semibold text-accent-text underline-offset-2 hover:underline" onClick={onMoreOptions}>
            More options…
          </button>
          <button type="button" className={secondary} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
