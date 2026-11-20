// Any model the browser imports, as the desktop's prepareImport picks its
// path (src/ui/ImportPipeline.cpp): LDraw files are read as they are; a
// Studio .io is unpacked (studioReader.ts) and drawn the same way, its own
// custom parts first, from Studio's library when the site has one.

import { emptyPart, prepareLDraw, type PrepareOptions, type PreparedPart } from './prepare';
import { readStudioIo } from './studioReader';

export type ModelFormat = 'ldraw' | 'studio';

export function formatOf(fileName: string): ModelFormat {
  return /\.io$/i.test(fileName) ? 'studio' : 'ldraw';
}

export const KIND_LABEL: Record<ModelFormat, string> = { ldraw: 'LDraw import', studio: 'Studio import' };

export async function prepareModel(fileName: string, bytes: Uint8Array, opts: PrepareOptions): Promise<PreparedPart> {
  const format = formatOf(fileName);
  if (format === 'studio') {
    const read = await readStudioIo(bytes);
    if (!read.ok) {
      const out = emptyPart(fileName, KIND_LABEL.studio);
      out.error = `Could not read ${fileName}: ${read.error}`;
      return out;
    }
    return prepareLDraw(fileName, '', { ...opts, read }, KIND_LABEL.studio);
  }
  return prepareLDraw(fileName, new TextDecoder().decode(bytes), opts, KIND_LABEL.ldraw);
}
