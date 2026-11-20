// The browser's own importer, from the page (docs/model-import.md, "In the
// browser"): a Web Worker (client/worker.ts) reads and draws the model, so
// the page stays responsive; Cancel ends the worker. When this browser
// can't (no workers or off-screen drawing, the worker crashes or runs out
// of memory, the library can't be reached), the import falls back to the
// server's converter.

import type { PartWire } from '../api';
import type { ConvertChoices } from './client/convert';
import type { FromWorker, ToWorker } from './client/protocol';
import type { ImportAnalysis, ImportStatus } from './importApi';

export type BrowserProgress = { phase: 'reading' | 'fetching' | 'drawing'; done?: number; total?: number };

/** Why the browser couldn't, when the server should take over. */
export class FallBack extends Error {}

/** Whether this browser can import `fileName` itself here. */
export function canImportInBrowser(fileName: string, status: Pick<ImportStatus, 'browser'> | null | undefined): boolean {
  const b = status?.browser;
  if (!b?.available || !libraryFor(fileName, status)) return false;
  const ext = /\.([A-Za-z]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? '';
  if (!b.extensions.includes(ext)) return false;
  return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}

/**
 * The library a model is drawn from, as the desktop's prepareImport picks it:
 * Studio's own for an .io when the site has it, else the LDraw library.
 */
export function libraryFor(fileName: string, status: Pick<ImportStatus, 'browser'> | null | undefined): { name: 'ldraw' | 'studio'; version: string } | null {
  const b = status?.browser;
  if (/\.io$/i.test(fileName) && b?.studio) return { name: 'studio', version: b.studio };
  return b?.ldraw ? { name: 'ldraw', version: b.ldraw } : null;
}

export type MadePart = Extract<FromWorker, { type: 'made-part' }>;
export type MadeLayout = Extract<FromWorker, { type: 'made-layout' }>;

/** One import in a worker: analyse, then make. */
export class BrowserImport {
  private worker: Worker | null;
  private waiting: { resolve: (m: FromWorker) => void; reject: (e: Error) => void } | null = null;
  private preview: string | null = null;

  constructor(
    private readonly onProgress: (p: BrowserProgress) => void,
    makeWorker: () => Worker = () => new Worker(new URL('./client/worker.ts', import.meta.url), { type: 'module' }),
  ) {
    this.worker = makeWorker();
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'progress') {
        this.onProgress({ phase: m.phase, ...(m.done !== undefined ? { done: m.done } : {}), ...(m.total !== undefined ? { total: m.total } : {}) });
        return;
      }
      const w = this.waiting;
      this.waiting = null;
      if (!w) return;
      if (m.type === 'failed') w.reject(m.fallback ? new FallBack(m.message) : new Error(m.message));
      else w.resolve(m);
    };
    // A crash, or the worker's code that wouldn't load: the server takes over.
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      this.fail(new FallBack(e.message || 'The import stopped in this browser.'));
    };
    this.worker.onmessageerror = () => this.fail(new FallBack('The import stopped in this browser.'));
  }

  private fail(e: Error) {
    const w = this.waiting;
    this.waiting = null;
    w?.reject(e);
  }

  private ask(msg: ToWorker): Promise<FromWorker> {
    if (!this.worker) return Promise.reject(new Error('cancelled'));
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.worker!.postMessage(msg);
    });
  }

  /** The analysis as the server's job has it, its preview a blob: URL (freed on cancel). */
  async analyse(file: File, library: { name: 'ldraw' | 'studio'; version: string }, parts: PartWire[]): Promise<ImportAnalysis> {
    const m = await this.ask({ type: 'analyse', file, library, parts });
    if (m.type !== 'analysed') throw new FallBack('Unexpected answer from the import worker.');
    const a = m.analysis;
    if (a.part) this.preview = URL.createObjectURL(a.part.preview);
    return { ...a, part: a.part ? { ...a.part, preview: this.preview! } : null };
  }

  async makePart(choices: ConvertChoices): Promise<MadePart> {
    const m = await this.ask({ type: 'convert', mode: 'part', choices });
    if (m.type !== 'made-part') throw new FallBack('Unexpected answer from the import worker.');
    return m;
  }

  async makeLayout(): Promise<MadeLayout> {
    const m = await this.ask({ type: 'convert', mode: 'parts' });
    if (m.type !== 'made-layout') throw new FallBack('Unexpected answer from the import worker.');
    return m;
  }

  /** Stop at once: the worker ends, whatever it was doing. */
  cancel(): void {
    this.worker?.terminate();
    this.worker = null;
    this.fail(new Error('cancelled'));
    if (this.preview) URL.revokeObjectURL(this.preview);
    this.preview = null;
  }
}

/** A Blob as base64 (for the JSON body of POST /api/imports/client). */
export async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function utf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
