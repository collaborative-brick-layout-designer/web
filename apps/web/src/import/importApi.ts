// The website's model import (server routes/imports.ts, docs/model-import.md).

import type { StockGuess } from '@cld/parts-catalog/browser';
import { apiGet, apiSend, friendlyErrorMessage, noteWrite } from '../api';

export interface ImportStatus {
  available: boolean;
  reason: 'off' | 'backup_off' | 'missing' | 'too_old' | 'broken' | 'unsandboxed' | null;
  message: string | null;
  extensions: string[];
  maxUploadBytes: number;
  perHour: number;
  libraries: { ldraw: boolean; ldd: boolean; lddMapping: boolean; studio: boolean };
  /** The browser's own importer: the files it reads here, and the libraries' versions. */
  browser?: { available: boolean; extensions: string[]; ldraw: string | null; studio: string | null; ldd?: string | null; lddMapping?: string | null };
}

export interface ImportConnection {
  type: string;
  x: number;
  y: number;
  angle: number;
}

export interface ImportStats {
  ldrawResolved: number;
  lddRendered: number;
  unresolved: number;
}

export interface ImportAnalysis {
  format: 'ldraw' | 'studio' | 'ldd';
  kindLabel: string;
  title: string;
  designer: string;
  suggestedName: string;
  partKey: string;
  partError: string | null;
  part: {
    widthStuds: number;
    heightStuds: number;
    pxPerStud: number;
    contentStuds: { x: number; y: number; width: number; height: number };
    baseOnGrid: boolean;
    snapMargin: { left: number; top: number; right: number; bottom: number };
    connections: ImportConnection[];
    stats: ImportStats;
    warnings: string[];
    preview: string;
    /** Where its trucks and couplers seem to be (the browser's import only; Trains › Import a model…). */
    stock?: StockGuess | null;
  } | null;
  layout: { sheets: number; bricks: number; warnings: string[]; partlyRead: boolean } | null;
  layoutError: string | null;
}

/** What the editor puts down itself (target "layout" with clientPlaces), as the model's .bbm has it. */
export interface ToPlace {
  bricks: {
    partNumber: string;
    displayArea: { x: number; y: number; width: number; height: number };
    orientation?: number;
    altitude?: number;
    myGroup?: string;
  }[];
  groups: { id: string; partNumber?: string; myGroup?: string }[];
}

export interface ImportResult {
  mode: 'part' | 'parts';
  /** Null when the part was only saved to the library. */
  layoutId: string | null;
  newLayout: boolean;
  part: { id: string; partNumber: string; displayName: string } | null;
  placed: number;
  sheetId: string | null;
  brickIds: string[];
  /** Into the open layout: the editor puts these down itself, in its own undo. */
  toPlace?: ToPlace | null;
  stats: ImportStats | null;
  warnings: string[];
  widthStuds: number | null;
  heightStuds: number | null;
  connections: number | null;
  sheets: number | null;
}

export interface ImportJob {
  id: string;
  fileName: string;
  state: 'queued' | 'analysing' | 'ready' | 'converting' | 'done' | 'failed' | 'cancelled';
  step: 'analyse' | 'convert';
  position: number;
  error: { code: string; message: string } | null;
  analysis: ImportAnalysis | null;
  result: ImportResult | null;
}

export type ImportTarget =
  | { kind: 'new'; title?: string; orgSlug?: string }
  // clientPlaces: the server answers with the parts (toPlace) and the editor puts them down,
  // so Undo takes them back. Without it (pages from before 2026-11-19) the server placed them.
  | { kind: 'layout'; layoutId: string; sheetId?: string; at?: { x: number; y: number }; clientPlaces: true }
  /** Only save the custom part, to you ('' / none) or a club; nothing is placed. */
  | { kind: 'library'; orgSlug?: string };

export interface ConvertChoices {
  mode: 'part' | 'parts';
  quarterTurns: number;
  align: '' | 'bottom' | 'box';
  nudge: [number, number];
  drop: number[];
  name: string;
  designer: string;
  designerUrl: string;
  category: string;
  target: ImportTarget;
}

/** POST /api/imports/client: a part (XML and PNG, base64) or a layout (.bbm text). */
export type ClientBody =
  | {
      mode: 'part';
      partKey: string;
      displayName: string;
      xmlBase64: string;
      spriteBase64: string;
      widthStuds: number;
      heightStuds: number;
      connections: number;
      category: string;
      stats: ImportStats;
      warnings: string[];
      target: ImportTarget;
    }
  | { mode: 'parts'; bbm: string; title: string; sheets: number; stats: ImportStats | null; warnings: string[]; target: ImportTarget };

/**
 * Whether this site imports models (the server's converter, or the browser's
 * own importer for the files it reads), or this file when one is named.
 */
export function canImport(s: ImportStatus | null | undefined, fileName?: string): boolean {
  if (!s) return false;
  if (s.available) return true;
  const b = s.browser;
  if (!b?.available) return false;
  if (fileName === undefined) return true;
  const ext = /\.([A-Za-z]+)$/.exec(fileName)?.[1]?.toLowerCase() ?? '';
  return b.extensions.includes(ext);
}

/** The files the website imports (the server says which). */
export const IMPORT_ACCEPT = '.ldr,.mpd,.dat,.io,.lxf,.lxfml';
export const IMPORTABLE = /\.(ldr|mpd|dat|io|lxf|lxfml)$/i;

export const importApi = {
  status: () => apiGet<ImportStatus>('/api/imports/status'),
  job: (id: string) => apiGet<ImportJob>(`/api/imports/${encodeURIComponent(id)}`),
  convert: (id: string, choices: ConvertChoices) => apiSend<ImportJob>('POST', `/api/imports/${encodeURIComponent(id)}/convert`, choices),
  /** What the browser's own importer made, saved as a job's result is. */
  client: (body: ClientBody) => apiSend<ImportResult>('POST', '/api/imports/client', body),
  cancel: async (id: string) => {
    await fetch(`/api/imports/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' }).catch(() => undefined);
  },
};

/** Upload a model, reporting how much has gone (0..1). Resolves with the new job. */
export function uploadModel(file: File, onProgress: (sent: number) => void, signal?: AbortSignal): Promise<ImportJob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/imports');
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = async () => {
      if (xhr.status === 202) {
        noteWrite('POST', '/api/imports');
        resolve(JSON.parse(xhr.responseText) as ImportJob);
        return;
      }
      const res = new Response(xhr.responseText, { status: xhr.status, headers: { 'content-type': 'application/json' } });
      reject(new Error(await friendlyErrorMessage(res, 'POST', '/api/imports')));
    };
    xhr.onerror = () => reject(new Error('The upload didn’t reach the server. Check your connection and try again.'));
    xhr.onabort = () => reject(new DOMException('Canceled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

/** The plain words for a server's refusal codes from the import routes. */
export function importErrorText(code: string, fallback: string): string {
  switch (code) {
    case 'import_rate_limited':
      return 'You’ve imported a lot in the last hour. Try again a little later.';
    case 'too_many_open_imports':
      return 'You have three imports open already. Finish or cancel one first.';
    case 'timeout':
      return 'This model took too long to read, so it was stopped. Very big models may be easier to import in the desktop app.';
    case 'file_too_large':
      return 'This file is bigger than this site takes.';
    case 'unsupported_type':
      return 'Only LDraw (.ldr, .mpd, .dat), BrickLink Studio (.io) and LDD (.lxf, .lxfml) files can be imported.';
    default:
      return fallback;
  }
}
