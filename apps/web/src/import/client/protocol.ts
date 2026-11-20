// What the page and the import worker (worker.ts) say to each other.

import type { PartWire } from '../../api';
import type { ImportAnalysis } from '../importApi';
import type { ConvertChoices } from './convert';

export interface LibraryVersions {
  ldraw: string | null;
  studio: string | null;
  ldd: string | null;
  lddMapping: string | null;
}

export type ToWorker =
  /** `libraries`: the site's libraries' versions (null: not there). */
  | { type: 'analyse'; file: File; libraries: LibraryVersions; parts: PartWire[] }
  | { type: 'convert'; mode: 'part'; choices: ConvertChoices }
  | { type: 'convert'; mode: 'parts' };

export type FromWorker =
  | { type: 'progress'; phase: 'reading' | 'fetching' | 'drawing'; done?: number; total?: number }
  /** The analysis as the server's job has it, its preview as a PNG. */
  | { type: 'analysed'; analysis: Omit<ImportAnalysis, 'part'> & { part: (Omit<NonNullable<ImportAnalysis['part']>, 'preview'> & { preview: Blob }) | null } }
  | { type: 'made-part'; partKey: string; displayName: string; xml: string; png: Blob; widthStuds: number; heightStuds: number; connections: number }
  | { type: 'made-layout'; bbm: string; sheets: number; bricks: number }
  /** `fallback`: the server's converter may do better (not a problem with the file itself). */
  | { type: 'failed'; message: string; fallback: boolean };
