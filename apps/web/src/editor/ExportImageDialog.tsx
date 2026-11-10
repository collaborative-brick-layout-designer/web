// Export as Image / Print / PDF dialog — port of MainWindowMenus.cpp:97-312.
//
// All modes render the WHOLE map (content bounds + margin, over the map
// background color, without grid/selection/cursors) — see exportRender.ts;
// desktop exports scene->itemsBoundingRect(), never just the viewport.
//
// Image: explicit width/height in px with keep-aspect (or a 1×/2×/4×
// preset), PNG or JPEG with quality, transparent background, antialias
// and the per-export "Embed general-info watermark" (always
// "author / LUG / event"); downloads client-side.
//
// Print: actual size, 1 stud = 8 mm (desktop File ▸ Print). The map is
// tiled over as many pages of the chosen paper as it needs; each page is
// rendered separately at the chosen DPI and laid out at its physical size
// in a print window, so printing at 100 % scale gives true size.
//
// PDF: one A3 page, orientation from the layout's aspect, 12 mm margins,
// map fitted (desktop File ▸ Export as PDF), written without a library.

import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { MAX_CANVAS_SIDE, aboutSize, aspectHeight, defaultExportSize, estimateImageBytes, type StudRect } from './exportRender';
import { useEditorStore, noticeDownloaded } from './editorStore';
import { buildImagePdf, dataUrlBytes, pdfPageLayout, printPixelRatio, printTiles } from './printLayout';
import { loadExportSettings, saveExportSettings } from './exportSettings';
import { HelpButton } from '../help/HelpButton';
import { sanitizeFilename } from '../bbmFiles';
import { useEscape } from './useEscape';
import { askConfirm } from '../ui/ConfirmDialog';

/** Above this many pages, Print asks first and offers a PDF instead. */
export const MANY_PRINT_PAGES = 20;

/** About how big the print pages' pictures are, all together (PNG at the DPI). */
export function estimatePrintBytes(pages: number, tileMm: { w: number; h: number }, dpi: number): number {
  const w = Math.max(1, Math.round((tileMm.w / 25.4) * dpi));
  const h = Math.max(1, Math.round((tileMm.h / 25.4) * dpi));
  return pages * estimateImageBytes(w, h, 'png');
}

export interface ExportHandle {
  /**
   * Render the full map to a canvas. `pixelRatio` is output px per scene
   * px (8 per stud); `size`, when given, is the exact output size instead.
   * The returned ratio is what was actually used after clamping to the
   * browser's canvas limits. Null when the map is empty.
   */
  render: (opts: {
    pixelRatio: number;
    transparent: boolean;
    size?: { width: number; height: number };
    antialias?: boolean;
    /** Stamp "author / LUG / event" bottom-right. */
    watermark?: boolean;
    /** Render only this map region (studs) — a print tile. */
    regionStuds?: StudRect;
  }) => { canvas: HTMLCanvasElement; pixelRatio: number } | null;
  /** The map's "export electric circuits" choice (<ExportElectricCircuit>). */
  exportElectric?: () => boolean;
  setExportElectric?: (on: boolean) => void;
  /** Scene-pixel size of the whole-map export (1×), or null when empty. */
  sceneSize: () => { width: number; height: number } | null;
  /** Stud region of the whole-map export, or null when empty. */
  region?: () => StudRect | null;
  /** The map area on screen now, in studs. */
  screenRegion?: () => StudRect | null;
  /** One picture of a view at exactly `size` px (savedViews.ts), or null when it can't. */
  renderPicture?: (
    spec: import('./savedViews').PictureSpec,
    size: { width: number; height: number },
  ) => Promise<HTMLCanvasElement | null>;
}

/** Print-page resolution for the PDF image (the page is A3). */
const PDF_DPI = 200;

interface Props {
  layoutTitle: string;
  exportImageRef: React.MutableRefObject<ExportHandle | null>;
  onClose: () => void;
}

// Paper sizes in mm (portrait). Landscape swaps w/h at use-time.
const PAPER_SIZES: Record<string, { w: number; h: number; label: string }> = {
  a4:      { w: 210, h: 297, label: 'A4 (210 × 297 mm)' },
  a4l:     { w: 297, h: 210, label: 'A4 Landscape (297 × 210 mm)' },
  a3:      { w: 297, h: 420, label: 'A3 (297 × 420 mm)' },
  a3l:     { w: 420, h: 297, label: 'A3 Landscape (420 × 297 mm)' },
  letter:  { w: 216, h: 279, label: 'Letter (216 × 279 mm)' },
  letterl: { w: 279, h: 216, label: 'Letter Landscape (279 × 216 mm)' },
};

/** The canvas as an image file, encoded off the main thread. */
function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture is too big to save. Try a smaller size.'))), type, quality),
  );
}

export function ExportImageDialog({ layoutTitle, exportImageRef, onClose }: Props) {
  useEscape(onClose);
  const [mode, setMode] = useState<'image' | 'print' | 'pdf'>('image');
  // Desktop remembers the watermark checkbox (QSettings export/watermark).
  const [watermark, setWatermark] = useState(() => useEditorStore.getState().showExportWatermark);
  // BlueBrick's "Electric circuits", remembered in the map.
  const [electric, setElectric] = useState(() => exportImageRef.current?.exportElectric?.() ?? false);
  // Native (1×) export size; the image defaults to 2×, like the old
  // resolution picker.
  const [scene] = useState(() => exportImageRef.current?.sceneSize() ?? null);
  // Settings from the last export, like desktop's QSettings export/*.
  const [saved] = useState(loadExportSettings);
  // A first export starts at 2x, or 4,000 px on the longest side when
  // that's smaller (defaultExportSize).
  const [width, setWidth] = useState(() =>
    saved ? Math.min(MAX_CANVAS_SIDE, saved.width) : scene ? defaultExportSize(scene).width : 1600,
  );
  const [keepAspect, setKeepAspect] = useState(saved?.keepAspect ?? true);
  const [customHeight, setCustomHeight] = useState(() =>
    saved ? Math.min(MAX_CANVAS_SIDE, saved.height) : scene ? defaultExportSize(scene).height : 1200,
  );
  const [format, setFormat] = useState<'png' | 'jpeg'>(saved?.format ?? 'png');
  const [quality, setQuality] = useState(saved?.quality ?? 90);
  const [antialias, setAntialias] = useState(saved?.antialias ?? true);
  const [transparent, setTransparent] = useState(saved?.transparent ?? false);
  const [dpi, setDpi] = useState(150);
  const [paperKey, setPaperKey] = useState('a3');
  const [marginMm, setMarginMm] = useState(10);
  const [overlapMm, setOverlapMm] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  /** Print: pages made so far, while they're being made. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const cancelPrint = useRef(false);

  const height = keepAspect && scene ? aspectHeight(width, scene) : customHeight;
  const sizeValid = width >= 1 && height >= 1 && width <= MAX_CANVAS_SIDE && height <= MAX_CANVAS_SIDE;

  function setScale(k: number) {
    if (!scene) return;
    setWidth(Math.min(MAX_CANVAS_SIDE, Math.round(scene.width * k)));
    setCustomHeight(Math.min(MAX_CANVAS_SIDE, Math.round(scene.height * k)));
  }

  async function doExportImage() {
    const handle = exportImageRef.current;
    if (!handle || !sizeValid) return;
    setExporting(true);
    setError('');
    // The overlay shows in the picture as asked, whatever the view shows now.
    const shown = useEditorStore.getState().showElectricCircuits;
    const swap = shown !== electric;
    try {
      handle.setExportElectric?.(electric);
      if (swap) {
        flushSync(() => useEditorStore.setState({ showElectricCircuits: electric }));
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      const jpeg = format === 'jpeg';
      const result = handle.render({
        pixelRatio: 1,
        size: { width, height },
        // JPEG has no alpha channel; paint the background.
        transparent: transparent && !jpeg,
        antialias,
        watermark,
      });
      if (!result) { setError('The map is empty.'); return; }
      useEditorStore.getState().setShowExportWatermark(watermark);
      saveExportSettings({ width, height, keepAspect, transparent, antialias, format, quality });
      // toBlob, not toDataURL: the browser encodes the picture off the main
      // thread, and there's no base64 copy of it. A big layout's export
      // (16,384 px wide) froze the page for seconds while it encoded.
      const blob = await canvasBlob(result.canvas, jpeg ? 'image/jpeg' : 'image/png', jpeg ? quality / 100 : undefined);
      const url = URL.createObjectURL(blob);
      const safe = safeTitle(layoutTitle);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safe}.${jpeg ? 'jpg' : 'png'}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      noticeDownloaded(a.download);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (swap) flushSync(() => useEditorStore.setState({ showElectricCircuits: shown }));
      setExporting(false);
    }
  }

  const paper = PAPER_SIZES[paperKey]!;
  const region = exportImageRef.current?.region?.() ?? null;
  const tiling = region ? printTiles(region, paper, marginMm, overlapMm) : null;

  async function doTiledPrint() {
    const handle = exportImageRef.current;
    if (!handle || !tiling) { setError('The map is empty.'); return; }
    const total = tiling.tiles.length;
    if (total > MANY_PRINT_PAGES) {
      const go = await askConfirm({
        title: `Print ${total.toLocaleString('en-US')} pages?`,
        removes: `At actual size this layout takes ${total.toLocaleString('en-US')} pages (${aboutSize(estimatePrintBytes(total, tiling.tileMm, dpi))} of pictures), and making them takes a while. You can stop at any time.`,
        keeps: 'For a picture of the whole layout on one page, use PDF (A3) instead.',
        confirmLabel: `Print ${total.toLocaleString('en-US')} pages`,
        danger: false,
        cancelLabel: 'Not now',
      });
      if (!go) return;
    }
    // Opened now, while the click still counts (a window opened after the
    // pages are made would be blocked), with a word until they're in.
    const win = window.open('', '_blank');
    if (!win) { setError('Pop-up blocked: allow pop-ups for this site and try again.'); return; }
    win.document.write(printHtml(safeTitle(layoutTitle), paper, marginMm, tiling.tileMm));
    win.document.close();
    setExporting(true);
    setError('');
    cancelPrint.current = false;
    const urls: string[] = [];
    const freeUrls = () => { for (const u of urls) URL.revokeObjectURL(u); };
    try {
      // Each page shows a paper-sized piece of the map at 1 stud = 8 mm,
      // rendered at the chosen DPI (desktop renders page by page too), a
      // page at a time so the page never freezes, each as a file (a blob
      // URL), not a long data: string.
      const pr = printPixelRatio(dpi);
      setProgress({ done: 0, total });
      for (const t of tiling.tiles) {
        if (cancelPrint.current || win.closed) {
          freeUrls();
          if (!win.closed) win.close();
          return;
        }
        const rendered = handle.render({ pixelRatio: pr, transparent: false, regionStuds: t });
        if (!rendered) { setError('The map is empty.'); freeUrls(); win.close(); return; }
        const blob = await canvasBlob(rendered.canvas, 'image/png');
        const url = URL.createObjectURL(blob);
        urls.push(url);
        const page = win.document.createElement('div');
        page.className = 'page';
        const img = win.document.createElement('img');
        img.src = url;
        img.alt = `Page ${urls.length}`;
        page.append(img);
        win.document.body.append(page);
        setProgress({ done: urls.length, total });
        // Let the page breathe between pages.
        await new Promise((res) => setTimeout(res, 0));
      }
      win.document.getElementById('making')?.remove();
      win.addEventListener('pagehide', freeUrls, { once: true });
      // Printed from here, not from a <script> in the page: the new window
      // inherits the app's CSP, which allows no inline scripts.
      win.setTimeout(() => win.print(), 400);
      onClose();
    } catch (e) {
      freeUrls();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      setExporting(false);
    }
  }

  function doExportPdf() {
    const handle = exportImageRef.current;
    if (!handle || !region) { setError('The map is empty.'); return; }
    setExporting(true);
    setError('');
    try {
      const layout = pdfPageLayout(region);
      const size = {
        width: Math.max(1, Math.round((layout.imageMm.w / 25.4) * PDF_DPI)),
        height: Math.max(1, Math.round((layout.imageMm.h / 25.4) * PDF_DPI)),
      };
      const rendered = handle.render({ pixelRatio: 1, size, transparent: false, antialias: true });
      if (!rendered) { setError('The map is empty.'); return; }
      const jpeg = dataUrlBytes(rendered.canvas.toDataURL('image/jpeg', 0.92));
      const pdf = buildImagePdf(layout, { bytes: jpeg, width: rendered.canvas.width, height: rendered.canvas.height }, layoutTitle);
      const url = URL.createObjectURL(new Blob([pdf as BlobPart], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeTitle(layoutTitle)}.pdf`;
      a.click();
      noticeDownloaded(a.download);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div role="dialog" aria-label="Export / Print" aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-96 rounded-lg border border-border bg-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">Export / Print</h2>
          <HelpButton helpKey="dialog.exportImage" />
        </div>

        {/* Mode toggle */}
        <div className="mb-4 flex rounded-lg border border-border text-xs">
          {(['image', 'print', 'pdf'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 py-1.5 ${mode === m ? 'bg-neutral-700 text-ink' : 'text-muted hover:bg-soft'}`}
            >
              {m === 'image' ? 'Export Image' : m === 'print' ? 'Print (1:1)' : 'PDF (A3)'}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3 text-sm">
          {mode === 'image' ? (
            <>
              <label className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted">Width (px)</span>
                <input
                  type="number"
                  aria-label="Width (px)"
                  min={1}
                  max={MAX_CANVAS_SIDE}
                  value={width}
                  onChange={(e) => setWidth(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                  className="w-24 rounded-lg border border-border bg-soft px-2 py-1 text-xs"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={keepAspect}
                  onChange={(e) => {
                    if (!e.target.checked) setCustomHeight(height);
                    setKeepAspect(e.target.checked);
                  }}
                />
                Keep aspect ratio (height auto)
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted">Height (px)</span>
                <input
                  type="number"
                  aria-label="Height (px)"
                  min={1}
                  max={MAX_CANVAS_SIDE}
                  value={height}
                  disabled={keepAspect}
                  onChange={(e) => setCustomHeight(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                  className="w-24 rounded-lg border border-border bg-soft px-2 py-1 text-xs disabled:opacity-50"
                />
              </label>
              {scene && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted">Preset</span>
                  <div className="flex gap-1">
                    {[1, 2, 4].map((k) => (
                      <button
                        key={k}
                        onClick={() => setScale(k)}
                        className="rounded-lg border border-border px-2 py-0.5 text-xs hover:bg-soft"
                        title={`${Math.round(scene.width * k)} × ${Math.round(scene.height * k)} px`}
                      >
                        {k}×
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {!sizeValid && (
                <p className="text-[10px] text-danger">Width and height must be 1–{MAX_CANVAS_SIDE} px.</p>
              )}
              {sizeValid && (
                <p className="text-xs text-muted" data-testid="image-estimate">
                  The file will be {aboutSize(estimateImageBytes(width, height, format, quality))}.
                </p>
              )}
              <label className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted">Format</span>
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value as 'png' | 'jpeg')}
                  className="rounded-lg border border-border bg-soft px-2 py-1 text-xs"
                >
                  <option value="png">PNG</option>
                  <option value="jpeg">JPEG</option>
                </select>
              </label>
              {format === 'jpeg' && (
                <label className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted">JPEG quality</span>
                  <span className="flex items-center gap-2">
                    <input
                      type="range"
                      aria-label="JPEG quality"
                      min={10}
                      max={100}
                      value={quality}
                      onChange={(e) => setQuality(Number(e.target.value))}
                    />
                    <span className="w-8 text-right text-xs text-neutral-300">{quality}</span>
                  </span>
                </label>
              )}
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={antialias}
                  onChange={(e) => setAntialias(e.target.checked)}
                />
                Antialias
              </label>
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={transparent && format === 'png'}
                  disabled={format === 'jpeg'}
                  onChange={(e) => setTransparent(e.target.checked)}
                />
                Transparent background{format === 'jpeg' ? ' (PNG only)' : ''}
              </label>
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={watermark}
                  onChange={(e) => setWatermark(e.target.checked)}
                />
                Add the author, club and event in the corner
              </label>
              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={electric} onChange={(e) => setElectric(e.target.checked)} />
                Electric circuits
              </label>
            </>
          ) : mode === 'pdf' ? (
            <p className="text-xs text-muted">
              One A3 page ({region && region.width >= region.height ? 'landscape' : 'portrait'}, from the layout&apos;s
              shape) with the whole map fitted inside 12 mm margins.
            </p>
          ) : (
            <>
              <label className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted">Paper size</span>
                <select
                  value={paperKey}
                  onChange={(e) => setPaperKey(e.target.value)}
                  className="rounded-lg border border-border bg-soft px-2 py-1 text-xs"
                >
                  {Object.entries(PAPER_SIZES).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted">DPI</span>
                <select
                  value={dpi}
                  onChange={(e) => setDpi(Number(e.target.value))}
                  className="rounded-lg border border-border bg-soft px-2 py-1 text-xs"
                >
                  <option value={96}>96 (screen)</option>
                  <option value={150}>150 (draft print)</option>
                  <option value={300}>300 (high quality)</option>
                </select>
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted">Page margin (mm)</span>
                <input
                  type="number"
                  aria-label="Page margin (mm)"
                  value={marginMm}
                  min={0}
                  max={50}
                  step={1}
                  onChange={(e) => setMarginMm(Math.max(0, Number(e.target.value)))}
                  className="w-20 rounded-lg border border-border bg-soft px-2 py-1 text-xs"
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted">Tile overlap (mm)</span>
                <input
                  type="number"
                  value={overlapMm}
                  min={0}
                  max={50}
                  step={1}
                  onChange={(e) => setOverlapMm(Math.max(0, Number(e.target.value)))}
                  className="w-20 rounded-lg border border-border bg-soft px-2 py-1 text-xs"
                />
              </label>
              <p className="text-xs text-neutral-300" data-testid="print-pages">
                {tiling
                  ? `${tiling.cols} × ${tiling.rows} = ${tiling.tiles.length.toLocaleString('en-US')} ${tiling.tiles.length === 1 ? 'page' : 'pages'} at actual size (1 stud = 8 mm), ${aboutSize(estimatePrintBytes(tiling.tiles.length, tiling.tileMm, dpi))} of pictures`
                  : 'The map is empty.'}
              </p>
              {tiling && tiling.tiles.length > MANY_PRINT_PAGES && (
                <p className="rounded-lg border border-line bg-soft px-2 py-1.5 text-xs text-ink" data-testid="print-many">
                  That’s a lot of paper. For the whole layout on one page, use{' '}
                  <button type="button" onClick={() => setMode('pdf')} className="font-semibold text-accent-text underline underline-offset-2">
                    PDF (A3)
                  </button>
                  .
                </p>
              )}
              <p className="text-[10px] text-muted">
                Opens a new tab with one page per tile — print it at 100 % scale (no &quot;fit to page&quot;) to keep the actual size.
              </p>
            </>
          )}
        </div>

        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
        {progress && (
          <div className="mt-3 space-y-1" data-testid="print-progress">
            <p className="text-xs text-ink">
              Making page {Math.min(progress.done + 1, progress.total).toLocaleString('en-US')} of {progress.total.toLocaleString('en-US')}…
            </p>
            <progress value={progress.done} max={progress.total} aria-label="Pages made" className="h-2 w-full accent-accent" />
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={() => {
              if (progress) {
                cancelPrint.current = true;
                return;
              }
              onClose();
            }}
            className="rounded-lg px-3 py-1.5 text-xs text-muted hover:bg-soft"
          >
            Cancel
          </button>
          <button
            onClick={mode === 'image' ? () => void doExportImage() : mode === 'print' ? () => void doTiledPrint() : doExportPdf}
            disabled={exporting || (mode === 'image' && !sizeValid)}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs text-accent-ink hover:bg-accent-hover disabled:opacity-50"
          >
            {exporting ? 'Working…' : mode === 'image' ? `Export ${format === 'jpeg' ? 'JPEG' : 'PNG'}` : mode === 'print' ? 'Open Print Preview' : 'Export PDF'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The layout's name as a file name: spaces and letters like é kept, only what no file name may hold replaced. */
function safeTitle(title: string): string {
  return sanitizeFilename(title);
}

/** Print window: one physical-size page per tile. */
function printHtml(
  title: string,
  paper: { w: number; h: number },
  marginMm: number,
  tileMm: { w: number; h: number },
): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  @page { size: ${paper.w}mm ${paper.h}mm; margin: ${marginMm}mm; }
  body { background: #888; }
  .page { width: ${tileMm.w}mm; height: ${tileMm.h}mm; overflow: hidden; break-after: page; background: #fff; }
  .page:last-child { break-after: auto; }
  img { width: ${tileMm.w}mm; height: ${tileMm.h}mm; display: block; }
  #making { font: 16px sans-serif; color: #fff; padding: 16px; }
  @media print { body { background: #fff; } #making { display: none; } }
</style>
</head>
<body>
<p id="making">Making the pages… The print box opens when they’re all here.</p>
</body>
</html>`;
}
