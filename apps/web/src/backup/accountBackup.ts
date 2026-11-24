// Profile › Back up your things: one zip of everything that is yours on
// this site (your own layouts, modules, venues and rolling stock, not your
// clubs'), made in this browser from the same pages the app already reads,
// and put back from it as new copies through the same pages the app saves
// with. So the server's own checks (whose things you may read, your usage
// limits) apply to both, and a restore never changes anything that exists:
// every item it brings back is a new one in your account.
//
// The zip:
//   manifest.json                       {format, version, server, exportedAt, account, items[]}
//   README.txt                          what it is, in plain words
//   layouts/<n> <title>.bld-layout      the layout file both apps open
//   modules/<n> <title>/module.json     {title, setup}
//   modules/<n> <title>/module.ydoc     the module's contents as the editor saves them
//   modules/<n> <title>/thumbnail.webp  its picture, when it has one
//   venues/<n> <title>.json             {name, data}
//   rolling-stock/<n> <title>.json      {record}
// Paths are only names inside the zip; nothing in it is ever written to disk.

import type { ModuleSetup } from '@cld/modules';
import { api, apiGet, friendlyErrorMessage, toBase64, type ModuleSummary, type RosterStock } from '../api';
import { buildZip, deflatedEntry, readZip, sanitizeFilename, type ZipEntry } from '../bbmFiles';
import { readLayoutFile } from '../layoutFile';

export const BACKUP_FORMAT = 'cbld-account-backup';
export const BACKUP_VERSION = 1;

export type BackupItemKind = 'layout' | 'module' | 'venue' | 'rolling-stock';

export interface BackupItem {
  kind: BackupItemKind;
  /** Its id on the server it came from. */
  id: string;
  title: string;
  /** Where it is in the zip: a file, or a folder (modules). */
  path: string;
  updatedAt: number | null;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  generator: string;
  server: string;
  exportedAt: string;
  account: { id: string; name: string };
  items: BackupItem[];
}

export const KIND_WORDS: Record<BackupItemKind, { one: string; many: string }> = {
  layout: { one: 'layout', many: 'layouts' },
  module: { one: 'module', many: 'modules' },
  venue: { one: 'venue', many: 'venues' },
  'rolling-stock': { one: 'engine or car', many: 'engines and cars' },
};

async function bytesOf(path: string): Promise<Uint8Array | null> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'include' });
  } catch {
    throw new Error('Couldn’t reach the server. Check the connection and try again.');
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await friendlyErrorMessage(res, 'GET', path));
  return new Uint8Array(await res.arrayBuffer());
}

const enc = new TextEncoder();
const json = (v: unknown) => enc.encode(JSON.stringify(v, null, 2));

function readme(m: BackupManifest): string {
  const n = (k: BackupItemKind) => m.items.filter((i) => i.kind === k).length;
  return [
    'A backup of your things on Collaborative Brick Layout Designer',
    '',
    `Made ${new Date(m.exportedAt).toLocaleString()} from ${m.server} for ${m.account.name}.`,
    `It holds ${n('layout')} layouts, ${n('module')} modules, ${n('venue')} venues and ${n('rolling-stock')} engines and cars.`,
    '',
    'To put them back: sign in, open your Profile, and under "Back up your things"',
    'choose "Restore from a backup" and pick this file. Each thing comes back as a',
    'new copy in your account; nothing you have is changed or replaced.',
    '',
    'The layouts (layouts/*.bld-layout) also open on their own in the desktop app',
    'and on the site (Open a file).',
    '',
  ].join('\n');
}

export interface Progress {
  done: number;
  total: number;
  /** What it is working on. */
  title: string;
}

/** Make the backup zip of the signed-in person's own things. */
export async function buildAccountBackup(me: { id: string; displayName: string }, onProgress: (p: Progress) => void = () => {}): Promise<{ bytes: Uint8Array; manifest: BackupManifest }> {
  const [layouts, modules, venues, stock] = await Promise.all([
    apiGet<{ layouts: { id: string; title: string; ownerUserId: string | null; updatedAt: number }[] }>('/api/layouts?owner=me'),
    apiGet<{ modules: ModuleSummary[] }>('/api/modules?owner=me'),
    apiGet<{ venues: { id: string; name: string; ownerUserId?: string | null; ownerOrgId: string | null; createdAt?: number }[] }>('/api/venues?owner=me'),
    apiGet<{ stock: RosterStock[] }>('/api/rolling-stock?owner=me'),
  ]);
  // Only what is yours: never a club's, never something shared with you.
  const mine = <T extends { ownerUserId?: string | null }>(xs: T[]) => xs.filter((x) => x.ownerUserId === me.id);
  const ls = mine(layouts.layouts);
  const ms = mine(modules.modules);
  const vs = mine(venues.venues);
  const ss = mine(stock.stock);
  const total = ls.length + ms.length + vs.length + ss.length;
  let done = 0;
  const step = (title: string) => onProgress({ done: done++, total, title });

  const entries: ZipEntry[] = [];
  const items: BackupItem[] = [];
  const name = (i: number, title: string, fallback: string) => `${String(i + 1).padStart(3, '0')} ${sanitizeFilename(title) || fallback}`;

  for (const [i, l] of ls.entries()) {
    step(l.title);
    const bytes = await bytesOf(`/api/layouts/${encodeURIComponent(l.id)}/export.bld-layout`);
    if (!bytes) continue; // deleted meanwhile
    const path = `layouts/${name(i, l.title, 'layout')}.bld-layout`;
    entries.push({ name: path, data: bytes });
    items.push({ kind: 'layout', id: l.id, title: l.title, path, updatedAt: l.updatedAt });
  }
  for (const [i, m] of ms.entries()) {
    step(m.title);
    const doc = await bytesOf(`/api/modules/${encodeURIComponent(m.id)}/snapshot`);
    if (!doc) continue;
    const folder = `modules/${name(i, m.title, 'module')}`;
    entries.push(await deflatedEntry({ name: `${folder}/module.json`, data: json({ title: m.title, setup: m.setup ?? null }) }));
    entries.push(await deflatedEntry({ name: `${folder}/module.ydoc`, data: doc }));
    if (m.thumbnailAt) {
      const pic = await bytesOf(`/api/modules/${encodeURIComponent(m.id)}/thumbnail`);
      if (pic) entries.push({ name: `${folder}/thumbnail.webp`, data: pic });
    }
    items.push({ kind: 'module', id: m.id, title: m.title, path: folder, updatedAt: (m as { updatedAt?: number }).updatedAt ?? null });
  }
  for (const [i, v] of vs.entries()) {
    step(v.name);
    const full = await api.venues.get(v.id).catch(() => null);
    if (!full) continue;
    const path = `venues/${name(i, v.name, 'venue')}.json`;
    entries.push(await deflatedEntry({ name: path, data: json({ name: full.name, data: full.data }) }));
    items.push({ kind: 'venue', id: v.id, title: v.name, path, updatedAt: v.createdAt ?? null });
  }
  for (const [i, s] of ss.entries()) {
    const title = [s.number, s.name].filter(Boolean).join(' ') || 'Engine or car';
    step(title);
    const path = `rolling-stock/${name(i, title, 'stock')}.json`;
    entries.push(await deflatedEntry({ name: path, data: json({ record: s.record }) }));
    items.push({ kind: 'rolling-stock', id: s.id, title, path, updatedAt: s.updatedAt });
  }
  onProgress({ done: total, total, title: '' });

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    generator: 'Collaborative Brick Layout Designer (web)',
    server: window.location.origin,
    exportedAt: new Date().toISOString(),
    account: { id: me.id, name: me.displayName },
    items,
  };
  entries.unshift({ name: 'README.txt', data: enc.encode(readme(manifest)) }, { name: 'manifest.json', data: json(manifest) });
  return { bytes: buildZip(entries), manifest };
}

export function backupFileName(now = new Date()): string {
  return `my-brick-layouts-backup-${now.toISOString().slice(0, 10)}.zip`;
}

// ---------------------------------------------------------------------------
// Reading one back
// ---------------------------------------------------------------------------

/** The most a backup may unpack to, and hold, in this browser. */
export const MAX_BACKUP_UNPACKED = 2 * 1024 ** 3;
export const MAX_BACKUP_ENTRIES = 20_000;

/** What a zip's central directory says it holds, before anything is unpacked (a zip bomb is refused here). */
export function zipDirectoryTotals(bytes: Uint8Array): { entries: number; unpacked: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  let unpacked = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip');
    unpacked += v.getUint32(p + 24, true);
    p += 46 + v.getUint16(p + 28, true) + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return { entries: count, unpacked };
}

export interface OpenedBackup {
  manifest: BackupManifest;
  /** The zip's files by name. */
  files: Map<string, Uint8Array>;
}

const NOT_A_BACKUP = 'This file isn’t a backup made by “Back up your things”. Choose the .zip it downloaded.';

/** Read a backup zip; throws a plain sentence when it isn't one. */
export async function openAccountBackup(bytes: Uint8Array): Promise<OpenedBackup> {
  let totals: { entries: number; unpacked: number };
  try {
    totals = zipDirectoryTotals(bytes);
  } catch {
    throw new Error(NOT_A_BACKUP);
  }
  if (totals.entries > MAX_BACKUP_ENTRIES || totals.unpacked > MAX_BACKUP_UNPACKED) throw new Error('This backup is too big to open here.');
  let entries: ZipEntry[];
  try {
    entries = await readZip(bytes);
  } catch {
    throw new Error(NOT_A_BACKUP);
  }
  const files = new Map(entries.map((e) => [e.name, e.data]));
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json') ?? new Uint8Array())) as BackupManifest;
  } catch {
    throw new Error(NOT_A_BACKUP);
  }
  if (manifest?.format !== BACKUP_FORMAT || !Array.isArray(manifest.items)) throw new Error(NOT_A_BACKUP);
  if (typeof manifest.version !== 'number' || manifest.version > BACKUP_VERSION) {
    throw new Error('This backup was made by a newer version of the site. Restore it on a site that has been updated.');
  }
  const kinds = new Set<BackupItemKind>(['layout', 'module', 'venue', 'rolling-stock']);
  manifest.items = manifest.items.filter(
    (i) => i && kinds.has(i.kind) && typeof i.path === 'string' && typeof i.title === 'string' && typeof i.id === 'string',
  );
  return { manifest, files };
}

// ---------------------------------------------------------------------------
// Conflicts and putting things back
// ---------------------------------------------------------------------------

export type Choice = 'add' | 'skip';

export interface PlannedItem {
  item: BackupItem;
  /** Something of yours it may be: the same thing (it still exists), or one with the same name. */
  clash: { why: 'same' | 'name'; title: string } | null;
  choice: Choice;
  /** The title it comes back with. */
  newTitle: string;
}

/** Your things now, to find what a backup's items clash with. */
export interface Existing {
  ids: Set<string>;
  /** Lower-cased titles, per kind. */
  titles: Record<BackupItemKind, Set<string>>;
}

export async function existingThings(me: { id: string }): Promise<Existing> {
  const [layouts, modules, venues, stock] = await Promise.all([
    apiGet<{ layouts: { id: string; title: string; ownerUserId: string | null }[] }>('/api/layouts?owner=me'),
    apiGet<{ modules: ModuleSummary[] }>('/api/modules?owner=me'),
    apiGet<{ venues: { id: string; name: string; ownerUserId?: string | null }[] }>('/api/venues?owner=me'),
    apiGet<{ stock: RosterStock[] }>('/api/rolling-stock?owner=me'),
  ]);
  const mine = <T extends { ownerUserId?: string | null }>(xs: T[]) => xs.filter((x) => x.ownerUserId === me.id);
  const lower = (s: string) => s.trim().toLowerCase();
  const ls = mine(layouts.layouts);
  const ms = mine(modules.modules);
  const vs = mine(venues.venues);
  const ss = mine(stock.stock);
  return {
    ids: new Set([...ls, ...ms, ...vs, ...ss].map((x) => x.id)),
    titles: {
      layout: new Set(ls.map((l) => lower(l.title))),
      module: new Set(ms.map((m) => lower(m.title))),
      venue: new Set(vs.map((v) => lower(v.name))),
      'rolling-stock': new Set(ss.map((s) => lower([s.number, s.name].filter(Boolean).join(' ')))),
    },
  };
}

/**
 * What a restore would do with each item. Something you still have (the
 * same one) is skipped unless you say otherwise; one with only the same
 * name comes back as a copy named "… (restored)"; the rest come back as
 * they were named. Nothing is ever replaced.
 */
export function planRestore(manifest: BackupManifest, existing: Existing): PlannedItem[] {
  return manifest.items.map((item) => {
    const lower = item.title.trim().toLowerCase();
    if (existing.ids.has(item.id)) return { item, clash: { why: 'same', title: item.title }, choice: 'skip', newTitle: `${item.title} (restored)` };
    if (existing.titles[item.kind].has(lower)) return { item, clash: { why: 'name', title: item.title }, choice: 'add', newTitle: `${item.title} (restored)` };
    return { item, clash: null, choice: 'add', newTitle: item.title };
  });
}

const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : null);

/** Put one item back, as a new thing in your account. Returns its new id. */
export async function restoreItem(p: PlannedItem, files: Map<string, Uint8Array>): Promise<string> {
  const { item } = p;
  const title = p.newTitle;
  if (item.kind === 'layout') {
    const bytes = files.get(item.path);
    if (!bytes) throw new Error('It is missing from the backup.');
    const file = await readLayoutFile(bytes);
    const made = await api.layouts.create({ title, bbm: file.bbm, ...(file.sidecar ? { sidecar: file.sidecar } : {}), ...(file.background ? { backgroundImage: file.background } : {}) });
    return made.id;
  }
  if (item.kind === 'module') {
    const meta = JSON.parse(text(files.get(`${item.path}/module.json`)) ?? '{}') as { setup?: ModuleSetup | null };
    const doc = files.get(`${item.path}/module.ydoc`);
    if (!doc) throw new Error('It is missing from the backup.');
    const made = await api.modules.create({ title });
    await api.modules.saveSnapshot(made.id, doc, 'Restored from a backup');
    if (meta.setup) await api.modules.setSetup(made.id, meta.setup);
    const pic = files.get(`${item.path}/thumbnail.webp`);
    if (pic) await api.modules.setThumbnail(made.id, { mime: 'image/webp', data: toBase64(pic) }).catch(() => undefined);
    return made.id;
  }
  if (item.kind === 'venue') {
    const v = JSON.parse(text(files.get(item.path)) ?? 'null') as { data?: unknown } | null;
    if (!v || v.data === undefined) throw new Error('It is missing from the backup.');
    return (await api.venues.create({ name: title, data: v.data })).id;
  }
  const s = JSON.parse(text(files.get(item.path)) ?? 'null') as { record?: Record<string, unknown> } | null;
  if (!s?.record || typeof s.record !== 'object') throw new Error('It is missing from the backup.');
  const record = { ...s.record };
  // Its link to the old roster entry would point at nothing here.
  delete record.libraryId;
  delete record.libraryVersion;
  if (p.newTitle !== item.title && typeof record.name === 'string') record.name = `${record.name} (restored)`;
  return (await api.rollingStock.create(record)).id;
}
