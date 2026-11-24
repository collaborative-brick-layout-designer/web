// The parts a .bld-layout carries (references/LAYOUT-FILE.md `parts/`):
// the ones the layout uses that aren't in the bundled library. On the web
// those are the custom parts; opening a file uploads the ones this server
// lacks as the user's own custom parts, as the desktop's Upload My Parts
// does (desktop PartsUpload.cpp). A part the server has as a custom part
// with a different definition is shown both ways first (desktop
// PartDifferencesDialog), and the user picks which to keep.

import type { BbmMap } from '@cld/model';
import { api, toBase64, type PartWire } from './api';
import { isLayoutPartFileName } from './layoutFile';

/** The custom part a brick's part number names, if it is one. */
function customPartFor(partNumber: string, parts: readonly PartWire[]): PartWire | undefined {
  const pn = partNumber.toLowerCase();
  // A bundled part of that key wins, as in the editor.
  if (parts.some((p) => p.source === 'bundled' && p.key.toLowerCase() === pn)) return undefined;
  // By its number, or by the `custom:<id>` the website places it as.
  return parts.find((p) => p.source === 'custom' && (p.partNumber.toLowerCase() === pn || p.key.toLowerCase() === pn));
}

/** The parts its engines and cars are drawn with (part and model looks), from the sidecar's text. */
export function stockPartKeys(sidecar: string | null): string[] {
  if (!sidecar) return [];
  try {
    const stock = (JSON.parse(sidecar) as { rollingStock?: { look?: { mode?: string; partKey?: string } }[] }).rollingStock ?? [];
    return stock.flatMap((s) => (s.look?.mode && s.look.mode !== 'simple' && typeof s.look.partKey === 'string' ? [s.look.partKey] : []));
  } catch {
    return [];
  }
}

export interface PartFetcher {
  xml: (customPartId: string) => Promise<Uint8Array>;
  sprite: (customPartId: string) => Promise<{ type: string; data: Uint8Array }>;
}

const fetchBytes = async (url: string) => {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return { type: res.headers.get('Content-Type') ?? '', data: new Uint8Array(await res.arrayBuffer()) };
};

export const serverParts: PartFetcher = {
  xml: async (id) => (await fetchBytes(api.customParts.xmlUrl(id))).data,
  sprite: (id) => fetchBytes(api.customParts.spriteUrl(id)),
};

/**
 * The files of the custom parts `map` uses, by file name: each part's
 * `<PartNumber>.xml` (`.set.xml` for a set) and its sprite beside it.
 */
export async function layoutPartFiles(
  map: BbmMap,
  parts: readonly PartWire[],
  fetcher: PartFetcher = serverParts,
  /** More part numbers it uses: engines and cars drawn with a part (an imported model's). */
  more: readonly string[] = [],
): Promise<Record<string, Uint8Array>> {
  const used = new Map<string, PartWire>();
  for (const id of more) {
    const part = id ? customPartFor(id, parts) : undefined;
    if (part) used.set(part.partNumber.toLowerCase(), part);
  }
  for (const layer of map.layers) {
    if (layer.type !== 'brick') continue;
    // Placed parts, and the custom sets they were placed from.
    for (const id of [...layer.bricks.map((b) => b.partNumber), ...(layer.groups ?? []).map((g) => g.partNumber)]) {
      const part = id ? customPartFor(id, parts) : undefined;
      if (part) used.set(part.partNumber.toLowerCase(), part);
    }
  }
  const files: Record<string, Uint8Array> = {};
  for (const part of used.values()) {
    const stem = part.kind === 'group' ? `${part.partNumber}.set` : part.partNumber;
    if (!isLayoutPartFileName(`${stem}.xml`)) continue;
    // A set has no picture of its own: its XML only.
    const [xml, sprite] = await Promise.all([fetcher.xml(part.customPartId!), part.noSprite ? undefined : fetcher.sprite(part.customPartId!)]);
    files[`${stem}.xml`] = xml;
    if (sprite) files[`${stem}.${sprite.type === 'image/gif' ? 'gif' : 'png'}`] = sprite.data;
  }
  return files;
}

export interface PartUpload {
  partNumber: string;
  displayName: string;
  xml: Uint8Array;
  /** Absent for a set (`.set.xml`): its parts draw it. */
  sprite?: Uint8Array;
  spriteMime?: 'image/gif' | 'image/png';
}

export interface PartsPlan {
  upload: PartUpload[];
  /** Parts the server has already: its own are used. */
  known: string[];
  /** Parts that can't become custom parts (no .png or .gif sprite). */
  skipped: string[];
}

function descriptionOf(xml: Uint8Array, fallback: string): string {
  const text = new TextDecoder().decode(xml);
  const en = /<Description>[\s\S]*?<en>([^<]*)<\/en>/i.exec(text)?.[1]?.trim();
  return en || fallback;
}

/** The sprite the server takes for a part's files: the .png, else the .gif. */
function spriteOf(files: Record<string, Uint8Array>, stem: string): Pick<PartUpload, 'sprite' | 'spriteMime'> | undefined {
  const png = files[`${stem}.png`];
  if (png) return { sprite: png, spriteMime: 'image/png' };
  const gif = files[`${stem}.gif`];
  return gif ? { sprite: gif, spriteMime: 'image/gif' } : undefined;
}

/** Which of a file's parts to upload: the ones the catalog lacks. */
export function planLayoutParts(files: Record<string, Uint8Array>, parts: readonly PartWire[]): PartsPlan {
  const have = new Set<string>();
  for (const p of parts) {
    have.add(p.key.toLowerCase());
    if (p.source === 'custom') have.add(p.partNumber.toLowerCase());
  }
  const plan: PartsPlan = { upload: [], known: [], skipped: [] };
  for (const name of Object.keys(files).sort()) {
    if (!/\.xml$/i.test(name) || !isLayoutPartFileName(name)) continue;
    const stem = name.slice(0, -4);
    const partNumber = stem.replace(/\.set$/i, '');
    if (have.has(partNumber.toLowerCase())) {
      plan.known.push(partNumber);
      continue;
    }
    const sprite = spriteOf(files, stem);
    // A set without a picture goes up as a set (newer servers take those).
    const isSet = /\.set$/i.test(stem) && /<group[\s>]/i.test(new TextDecoder().decode(files[name]!));
    if (!sprite && !isSet) {
      plan.skipped.push(partNumber);
      continue;
    }
    plan.upload.push({ partNumber, displayName: descriptionOf(files[name]!, partNumber), xml: files[name]!, ...sprite });
  }
  return plan;
}

/**
 * Upload the parts a layout file carries that the server lacks, as the
 * user's (or `orgSlug`'s) custom parts. Returns what to tell the user.
 */
export async function uploadLayoutParts(
  files: Record<string, Uint8Array> | undefined,
  loadCatalog: () => Promise<readonly PartWire[]>,
  orgSlug?: string,
): Promise<string[]> {
  if (!files || Object.keys(files).length === 0) return [];
  const plan = planLayoutParts(files, await loadCatalog());
  const failed: string[] = [];
  for (const p of plan.upload) {
    try {
      await api.customParts.create({
        partNumber: p.partNumber,
        displayName: p.displayName,
        xmlBase64: toBase64(p.xml),
        ...(p.sprite && p.spriteMime ? { spriteBase64: toBase64(p.sprite), spriteMime: p.spriteMime } : {}),
        ...(orgSlug ? { orgSlug } : {}),
      });
    } catch {
      failed.push(p.partNumber);
    }
  }
  const notes: string[] = [];
  const added = plan.upload.length - failed.length;
  if (added > 0) notes.push(`${added} part${added === 1 ? '' : 's'} from the layout added to your custom parts`);
  if (plan.skipped.length) notes.push(`no sprite the server takes for ${plan.skipped.join(', ')}`);
  if (failed.length) notes.push(`could not upload ${failed.join(', ')}`);
  return notes;
}

/** A part the file carries that the server has as a custom part, defined differently. */
export interface PartDifference {
  /** The part's key as the file names it, e.g. `MINE.1`. */
  partNumber: string;
  /** The server's custom part, and its part number as the server spells it. */
  customPartId: string;
  serverPartNumber: string;
  serverXml: string;
  fileXml: string;
  /** The file's sprite, when it has one the server takes. */
  sprite?: Uint8Array;
  spriteMime?: 'image/gif' | 'image/png';
}

export interface PartDifferences {
  differing: PartDifference[];
  /** Bundled parts the file defines differently: the web can't replace those. */
  bundled: string[];
}

/** Keep the server's, use the file's, or keep both (the file's under a new number). */
export type PartChoice = 'server' | 'file' | 'both';

const fetchText = async (url: string) => {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
};

/**
 * The file's parts the server already has with a different definition
 * (trimmed XML text compared). Only custom parts can be replaced; bundled
 * ones that differ are only named.
 */
export async function findPartDifferences(
  files: Record<string, Uint8Array> | undefined,
  parts: readonly PartWire[],
  getText: (url: string) => Promise<string> = fetchText,
): Promise<PartDifferences> {
  const out: PartDifferences = { differing: [], bundled: [] };
  if (!files) return out;
  const decoder = new TextDecoder();
  for (const name of Object.keys(files).sort()) {
    if (!/\.xml$/i.test(name) || !isLayoutPartFileName(name)) continue;
    const stem = name.slice(0, -4);
    const partNumber = stem.replace(/\.set$/i, '');
    const pn = partNumber.toLowerCase();
    const fileXml = decoder.decode(files[name]!);
    const bundled = parts.find((p) => p.source === 'bundled' && p.key.toLowerCase() === pn);
    if (bundled) {
      if (!bundled.spritePath) continue;
      const theirs = await getText(`/parts/${bundled.spritePath.replace(/\.[^./]+$/, '.xml')}`).catch(() => null);
      if (theirs !== null && theirs.trim() !== fileXml.trim()) out.bundled.push(partNumber);
      continue;
    }
    const custom = parts.find((p) => p.source === 'custom' && p.partNumber.toLowerCase() === pn && p.customPartId);
    if (!custom) continue;
    const serverXml = await getText(api.customParts.xmlUrl(custom.customPartId!));
    if (serverXml.trim() === fileXml.trim()) continue;
    out.differing.push({
      partNumber,
      customPartId: custom.customPartId!,
      serverPartNumber: custom.partNumber,
      serverXml,
      fileXml,
      ...spriteOf(files, stem),
    });
  }
  return out;
}

/** A part's description (English first) and author, from its XML. */
export function partInfo(xml: string): { description: string; author: string } {
  const unescape = (t: string) =>
    t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
  const author = unescape(/<Author>([^<]*)<\/Author>/i.exec(xml)?.[1] ?? '');
  const block = /<Description>([\s\S]*?)<\/Description>/i.exec(xml)?.[1] ?? '';
  const en = /<en>([^<]*)<\/en>/i.exec(block)?.[1];
  const first = /<(\w+)>([^<]*)<\/\1>/.exec(block)?.[2];
  return { description: unescape(en?.trim() ? en : (first ?? '')), author };
}

/**
 * The next part number free for keeping both: `<PartNumber>-2.<Color>`,
 * then `-3` and on (desktop unusedPartKey). Taken are the catalog's parts
 * and the parts the file carries (a set's file is `.set.xml`).
 */
export function nextFreePartNumber(
  partNumber: string,
  parts: readonly PartWire[],
  files: Record<string, Uint8Array> = {},
  alsoTaken: readonly string[] = [],
): string {
  const taken = new Set(alsoTaken.map((t) => t.toLowerCase()));
  for (const p of parts) taken.add((p.source === 'custom' ? p.partNumber : p.key).toLowerCase());
  for (const name of Object.keys(files)) {
    if (/\.xml$/i.test(name)) taken.add(name.slice(0, -4).replace(/\.set$/i, '').toLowerCase());
  }
  const dot = partNumber.lastIndexOf('.');
  const hasColor = dot > 0 && dot < partNumber.length - 1;
  const number = hasColor ? partNumber.slice(0, dot) : partNumber;
  const color = hasColor ? partNumber.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${number}-${n}${color}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * The map with every brick and group of part `from` switched to `to`
 * (desktop renamePartInMap). Leaves `map` as it is.
 */
export function renamePartInMap(map: BbmMap, from: string, to: string): { map: BbmMap; changed: number } {
  const key = from.toLowerCase();
  let changed = 0;
  const layers = map.layers.map((layer) => {
    if (layer.type !== 'brick') return layer;
    const bricks = layer.bricks.map((b) => {
      if (b.partNumber.toLowerCase() !== key) return b;
      changed++;
      return { ...b, partNumber: to };
    });
    const groups = layer.groups.map((g) => {
      if (!g.partNumber || g.partNumber.toLowerCase() !== key) return g;
      changed++;
      return { ...g, partNumber: to };
    });
    return { ...layer, bricks, groups };
  });
  return { map: { ...map, layers }, changed };
}

/** The .bbm text with the parts renamed, `[from, to]` each. */
export async function renamePartsInBbm(bbm: string, renames: readonly (readonly [string, string])[]): Promise<string> {
  if (renames.length === 0) return bbm;
  const { readBbm, writeBbm } = await import('@cld/bbm/browser');
  let map = readBbm(bbm).map;
  for (const [from, to] of renames) map = renamePartInMap(map, from, to).map;
  return writeBbm(map, { recomputeNbItems: false });
}

/**
 * Carry out the choices for the parts that differ (`null`: keep all the
 * server's). Returns the renames the layout needs and what to tell the user.
 */
export async function applyPartChoices(
  differences: PartDifferences,
  choices: readonly PartChoice[] | null,
  parts: readonly PartWire[],
  files: Record<string, Uint8Array>,
  orgSlug?: string,
): Promise<{ renames: [string, string][]; notes: string[]; changed: boolean }> {
  const renames: [string, string][] = [];
  const replaced: string[] = [];
  const added: string[] = [];
  const kept: string[] = [];
  const failed: string[] = [];
  const encoder = new TextEncoder();
  for (const [i, d] of differences.differing.entries()) {
    const choice = choices?.[i] ?? 'server';
    if (choice === 'server') {
      kept.push(d.partNumber);
      continue;
    }
    if (!d.sprite || !d.spriteMime) {
      failed.push(d.partNumber);
      continue;
    }
    const xml = encoder.encode(d.fileXml);
    try {
      if (choice === 'file') {
        await api.customParts.replace(d.customPartId, {
          partNumber: d.serverPartNumber,
          displayName: descriptionOf(xml, d.serverPartNumber),
          xmlBase64: toBase64(xml),
          spriteBase64: toBase64(d.sprite),
          spriteMime: d.spriteMime,
        });
        replaced.push(d.partNumber);
      } else {
        const partNumber = nextFreePartNumber(d.partNumber, parts, files, renames.map(([, to]) => to));
        await api.customParts.create({
          partNumber,
          displayName: descriptionOf(xml, partNumber),
          xmlBase64: toBase64(xml),
          spriteBase64: toBase64(d.sprite),
          spriteMime: d.spriteMime,
          ...(orgSlug ? { orgSlug } : {}),
        });
        renames.push([d.partNumber, partNumber]);
        added.push(`${d.partNumber} as ${partNumber}`);
      }
    } catch {
      failed.push(d.partNumber);
    }
  }
  const notes: string[] = [];
  if (replaced.length) notes.push(`the layout's ${replaced.join(', ')} replaced the server's`);
  if (added.length) notes.push(`the layout's ${added.join(', ')} added`);
  if (kept.length) notes.push(choices ? `the server's ${kept.join(', ')} kept` : `the server's ${kept.join(', ')} kept, which differ from the layout's`);
  if (failed.length) notes.push(`could not take the layout's ${failed.join(', ')}`);
  if (differences.bundled.length) notes.push(`the bundled ${differences.bundled.join(', ')} kept, which differ from the layout's`);
  return { renames, notes, changed: replaced.length + added.length > 0 };
}

/**
 * Everything opening a layout file does with its parts: asks about the
 * ones that differ from the server's, uploads the missing ones, carries
 * out the choices, and renames kept-both parts in the map. `ask` answers
 * `null` for keep all the server's.
 */
export async function takeLayoutParts(
  files: Record<string, Uint8Array> | undefined,
  bbm: string,
  loadCatalog: () => Promise<readonly PartWire[]>,
  ask: (differing: PartDifference[]) => Promise<PartChoice[] | null>,
  orgSlug?: string,
): Promise<{ bbm: string; notes: string[]; changed: boolean }> {
  if (!files || Object.keys(files).length === 0) return { bbm, notes: [], changed: false };
  const catalog = await loadCatalog();
  const differences = await findPartDifferences(files, catalog);
  const choices = differences.differing.length ? await ask(differences.differing) : null;
  const uploaded = await uploadLayoutParts(files, loadCatalog, orgSlug);
  const applied = await applyPartChoices(differences, choices, catalog, files, orgSlug);
  return {
    bbm: await renamePartsInBbm(bbm, applied.renames),
    notes: [...uploaded, ...applied.notes],
    changed: uploaded.length > 0 || applied.changed,
  };
}
