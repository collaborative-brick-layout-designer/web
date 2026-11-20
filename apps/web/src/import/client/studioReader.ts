// BrickLink Studio's .io files: the desktop's readStudioIo (src/import/
// studio/StudioReader.cpp). An .io is a ZIP (Studio 2.1 and later encrypt
// every entry with ZipCrypto under Studio's published password) holding
// model.ldr (an MPD: the first "0 FILE" is the model) and the model's own
// parts in CustomParts/*.dat. The model is read as any LDraw model; the
// custom parts come first when its parts are looked up (`overlay`).

import { emptyRead, readLDraw, type LDrawReadResult } from './ldrawReader';
import { SafeZip, STUDIO_PASSWORDS, ZipReadFailed, type ZipEntry, type ZipReadError } from './zip';

const MAX_MODEL_BYTES = 128 * 1024 * 1024;
const MAX_CUSTOM_PART_BYTES = 64 * 1024 * 1024;
const MAX_CUSTOM_PARTS_TOTAL = 512 * 1024 * 1024;
const MAX_CUSTOM_PARTS = 5000;

function friendly(why: ZipReadError, entry: string): string {
  switch (why) {
    case 'aes':
      return "This Studio file is locked with a password (AES encryption), so it can't be opened. Save it again in Studio without a password and import that copy.";
    case 'wrong-password':
      return "This Studio file is encrypted in a way we don't recognise. Open it in a current version of Studio, save it again and import that copy.";
    case 'too-big':
      return `The model in this Studio file (${entry}) is too large to import.`;
    case 'unsupported':
      return `This Studio file uses a compression method we can't read (${entry}). Save it again in Studio and import that copy.`;
    default:
      return `The model in this Studio file is damaged (${entry} failed its check).`;
  }
}

/** model.ldr at the root (any case), else any other .ldr but modelv1.ldr, with model2.ldr last. */
function modelCandidates(zip: SafeZip): ZipEntry[] {
  const out: ZipEntry[] = [];
  const first = zip.find('model.ldr', true);
  if (first) out.push(first);
  let model2: ZipEntry | null = null;
  for (const e of zip.entries) {
    if (e.isDir || out.includes(e) || !e.name.toLowerCase().endsWith('.ldr')) continue;
    const base = e.name.slice(e.name.lastIndexOf('/') + 1).toLowerCase();
    if (base === 'modelv1.ldr') continue;
    if (base === 'model2.ldr') {
      model2 = e;
      continue;
    }
    out.push(e);
  }
  if (model2) out.push(model2);
  return out;
}

/** Anything beyond comments: a reference or geometry line. */
function hasContent(bytes: Uint8Array): boolean {
  let lineStart = true;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i]!;
    if (c === 0x0a) {
      lineStart = true;
      continue;
    }
    if (lineStart && (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0b || c === 0x0c)) continue;
    if (lineStart && c >= 0x31 && c <= 0x35) return true;
    lineStart = false;
  }
  return false;
}

/** CustomParts/<name>.dat, directly in that folder, a plain name. */
function customPartName(e: ZipEntry): string | null {
  if (e.isDir || e.isSymLink) return null;
  const name = e.name.replace(/\\/g, '/');
  if (!name.toLowerCase().startsWith('customparts/')) return null;
  const rest = name.slice(12);
  if (rest.includes('/') || rest.includes('..') || !/^[A-Za-z0-9_][A-Za-z0-9_ .+()-]{0,200}\.dat$/i.test(rest)) return null;
  return rest;
}

export async function readStudioIo(bytes: Uint8Array): Promise<LDrawReadResult> {
  const out = emptyRead();
  const zip = new SafeZip(bytes, STUDIO_PASSWORDS);
  if (!zip.valid) {
    out.error = "This isn't a Studio model, or the file is damaged: Studio .io files are ZIP archives and this one can't be opened.";
    return out;
  }
  let ldr: Uint8Array | null = null;
  let firstError: ZipReadError | null = null;
  let firstEntry = '';
  const candidates = modelCandidates(zip);
  for (const entry of candidates) {
    let data: Uint8Array;
    try {
      data = await zip.read(entry, MAX_MODEL_BYTES);
    } catch (e) {
      const why = e instanceof ZipReadFailed ? e.why : 'damaged';
      if (!firstError) {
        firstError = why;
        firstEntry = entry.name;
      }
      // Every entry of an AES file is AES; no point trying the rest.
      if (why === 'aes' || why === 'wrong-password') break;
      continue;
    }
    // LDraw is text: nothing after a NUL belongs to the model.
    const nul = data.indexOf(0);
    const text = nul >= 0 ? data.subarray(0, nul) : data;
    if (hasContent(text)) {
      ldr = text;
      break;
    }
  }
  if (!ldr) {
    if (firstError) out.error = friendly(firstError, firstEntry);
    else if (candidates.length === 0) out.error = 'This Studio file has no model in it (model.ldr is missing).';
    else out.error = 'The model in this Studio file is empty.';
    return out;
  }

  // The model's own parts.
  const overlay = new Map<string, string>();
  let count = 0;
  let total = 0;
  const unreadable: string[] = [];
  for (const e of zip.entries) {
    const name = customPartName(e);
    if (!name) continue;
    if (++count > MAX_CUSTOM_PARTS || total + e.size > MAX_CUSTOM_PARTS_TOTAL) {
      out.warnings.push('This Studio file has more custom parts than we unpack; some may be missing.');
      break;
    }
    try {
      const data = await zip.read(e, MAX_CUSTOM_PART_BYTES);
      total += data.length;
      overlay.set(name.toLowerCase(), new TextDecoder().decode(data));
    } catch {
      unreadable.push(name);
    }
  }
  if (unreadable.length) out.warnings.push(`Some custom parts in this Studio file couldn't be unpacked and won't show: ${unreadable.join(', ')}`);

  const nested = readLDraw(new TextDecoder().decode(ldr));
  if (!nested.ok) {
    if (!nested.error) nested.error = "The model in this Studio file can't be read.";
    return nested;
  }
  nested.warnings = [...out.warnings, ...nested.warnings];
  if (count > 0) nested.overlay = overlay;
  return nested;
}
