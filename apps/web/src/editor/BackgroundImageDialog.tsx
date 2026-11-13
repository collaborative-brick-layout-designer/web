// Map > Background Image dialog — port of desktop MapView background image
// workflow. Stores image server-side + records metadata in sidecar.

import { useRef, useState } from 'react';
import type * as Y from 'yjs';
import type { BackgroundImage } from '@cld/bbm';
import type { BbmMap } from '@cld/model';
import { readSidecarFromDoc } from '@cld/ydoc';
import { setBackgroundImage, clearBackgroundImage } from './mutations';
import { friendlyErrorMessage, noteWrite } from '../api';
import { confirmDelete } from '../ui/ConfirmDialog';
import { useEscape } from './useEscape';
import { fitImageRect } from './background';
import { contentBoundsStuds } from './exportRender';

interface Props {
  layoutId: string;
  doc: Y.Doc;
  /** The layout, to fit a new picture over its parts. */
  map?: BbmMap | null;
  onClose: () => void;
}

/** The placement boxes, in plain words. */
const RECT_WORDS = { x: 'Left', y: 'Top', w: 'Width', h: 'Height' } as const;

export function BackgroundImageDialog({ layoutId, doc, map, onClose }: Props) {
  useEscape(onClose);
  const existing = readSidecarFromDoc(doc)?.backgroundImage ?? null;

  const [file, setFile] = useState<File | null>(null);
  const [opacity, setOpacity] = useState(existing?.opacity ?? 0.5);
  const [useRect, setUseRect] = useState(!!existing?.rect);
  const [rect, setRect] = useState(existing?.rect ?? { x: 0, y: 0, w: 100, h: 100 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // A new picture: fitted over the parts, keeping its shape (not a 100 × 100 box at 0,0).
  async function pick(f: File | null) {
    setFile(f);
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      const fit = fitImageRect(map ? contentBoundsStuds(map) : null, { width: bmp.width, height: bmp.height });
      bmp.close();
      const round = (v: number) => Math.round(v * 10) / 10;
      setRect({ x: round(fit.x), y: round(fit.y), w: round(fit.w), h: round(fit.h) });
      setUseRect(true);
    } catch {
      // Not readable here: the server says so on OK.
    }
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      let url = existing?.url ?? `/api/layouts/${layoutId}/background-image`;
      if (file) {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`/api/layouts/${layoutId}/background-image`, {
          method: 'POST',
          body: form,
          credentials: 'include',
        });
        if (!res.ok) throw new Error(await friendlyErrorMessage(res, 'POST', `/api/layouts/${layoutId}/background-image`));
        noteWrite('POST', `/api/layouts/${layoutId}/background-image`);
        const data = (await res.json()) as { url: string };
        url = data.url;
      }
      const bg: BackgroundImage = {
        url,
        opacity,
        ...(useRect ? { rect } : {}),
      };
      setBackgroundImage(doc, bg);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const ok = await confirmDelete('the background image', {
      title: 'Remove the background image?',
      verb: 'Remove',
      removes: 'The picture behind this layout is deleted from the server.',
      keeps: 'Your parts and sheets don’t change. You can add a picture again.',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/layouts/${layoutId}/background-image`, {
        method: 'DELETE',
        credentials: 'include',
      });
      // Gone already (404) is fine; anything else keeps the picture.
      if (!res.ok && res.status !== 404) {
        setError('Couldn’t remove the picture. Try again.');
        return;
      }
      noteWrite('DELETE', `/api/layouts/${layoutId}/background-image`);
      // The file is gone, so this isn't an undo step (Undo would bring back a broken picture).
      clearBackgroundImage(doc, { untracked: true });
      onClose();
    } catch {
      setError('Failed to remove');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-label="Background image" aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-104 rounded-lg border border-line bg-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">Background Image</h2>

        <div className="mt-4 space-y-3 text-sm">
          <div>
            {/* The whole label, words and box, opens the file picker: a 44 px target. */}
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Picture (PNG, JPG, GIF or WebP, up to 10 MB)</span>
              <input
                ref={inputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                id="bg-image-file"
                onChange={(e) => void pick(e.target.files?.[0] ?? null)}
                className="block min-h-11 w-full text-xs text-muted file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-lg file:border file:border-border file:bg-soft file:px-3 file:text-ink hover:file:bg-panel"
              />
            </label>
            {existing?.url && !file && (
              <p className="mt-1 text-xs text-muted">
                Current image will be kept unless you choose a new file.
              </p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <label htmlFor="bg-image-opacity" className="text-xs text-muted w-16">Opacity</label>
            <input
              id="bg-image-opacity"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={opacity}
              onChange={(e) => setOpacity(parseFloat(e.target.value))}
              className="flex-1 accent-accent"
            />
            <span className="text-xs tabular-nums text-muted w-8 text-right">
              {Math.round(opacity * 100)}%
            </span>
          </div>

          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={useRect}
              onChange={(e) => setUseRect(e.target.checked)}
              className="accent-accent"
            />
            Custom placement (studs)
          </label>

          {useRect && (
            <div className="grid grid-cols-2 gap-2 pl-5">
              {(['x', 'y', 'w', 'h'] as const).map((k) => (
                <label key={k} className="flex flex-col gap-0.5">
                  <span className="text-xs text-muted">{RECT_WORDS[k]}</span>
                  <input
                    type="number"
                    aria-label={`${RECT_WORDS[k]} (studs)`}
                    value={rect[k]}
                    onChange={(e) => setRect((r) => ({ ...r, [k]: parseFloat(e.target.value) || 0 }))}
                    className="rounded-lg border border-border bg-soft px-2 py-1 text-xs"
                  />
                </label>
              ))}
            </div>
          )}
        </div>

        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        {!file && !existing && (
          <p className="mt-2 text-xs text-muted" data-testid="background-pick-hint">
            Choose a picture first. It’s fitted over your parts; tick Custom placement to move it.
          </p>
        )}

        <div className="mt-5 flex items-center justify-between">
          {existing && (
            <button
              onClick={remove}
              disabled={busy}
              className="rounded-lg border border-red-900 px-3 py-1 text-xs text-danger hover:bg-red-950 disabled:opacity-50"
            >
              Remove image
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button
              onClick={onClose}
              className="rounded-lg border border-border px-3 py-1 text-xs hover:bg-soft"
            >
              Cancel
            </button>
            <button
              onClick={commit}
              disabled={busy || (!file && !existing)}
              className="rounded-lg bg-accent text-accent-ink px-3 py-1 text-xs hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'OK'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
