// One-time fix: drawing settings saved out of range before the live route
// checked them (ws/drawingSettings.ts, ws/gridGuard.ts) are put back in
// range, everywhere the apps read a layout or module document from:
//
//   - layouts: the live document (doc_snapshot plus its layout_updates);
//   - modules: doc_snapshot;
//   - module_versions: doc_snapshot (Restore makes one the module again);
//   - catalog_item_versions of a layout or module: doc_snapshot (a copy
//     from the catalog becomes a new layout or module).
//
// "Out of range" is what the live route refuses (the guard's own rules,
// SHEET_RULES and RULER_RULES, and a grid's cell size): after the fix every
// document passes drawingProblems with nothing left. Each value out of
// range gets what @cld/ydoc keepDrawnSettingsInRange (the desktop's
// core::keepDrawnSettingsInRange) makes of it: the nearest end of its
// range, the default for one that isn't a number, no dash pattern for one
// that can't be drawn. One the clamp can't bring into range (a font that
// isn't an object, a nested Yjs type) is removed, as the apps then use
// their default; a grid's cell size is never removed, it gets the default.
// Nothing else is touched.
//
// The fix is an ordinary Yjs update on each document: a layout's is stored
// as one more layout_updates row (or applied to the live room when the
// layout is open, which stores it and sends it to everyone there), so the
// desktop and every browser get it by syncing, never as a fork. A module's
// or a version's snapshot is the old snapshot merged with that update.
//
// Rows are read a page at a time and documents one at a time, so memory
// stays at about one document. Running it again changes nothing.

import type Database from 'better-sqlite3';
import * as Y from 'yjs';
import type { BbmMap } from '@cld/model';
import { DRAWN_LIMITS, keepDrawnSettingsInRange } from '@cld/ydoc';
import { RULER_RULES, SHEET_RULES, type Rule } from '../ws/drawingSettings.js';
import { drawingProblems, validGridSize } from '../ws/gridGuard.js';
import { applyStoredUpdate } from '../ws/yjsWork.js';

/** The fix's name: its data_fixes row, and the CBLD_DATA_FIX value that runs it. */
export const CLAMP_FIX_ID = 'clamp-drawing-values';

/** The origin of the fix's Yjs transactions. */
export const CLAMP_ORIGIN = 'cld-clamp-drawing-values';

/** One value the fix changes. `to` undefined: the field is removed. */
export interface ValueChange {
  /** `sheet.transparency`, `grid.subDivisionNumber`, `area.areaCellSize`, `ruler.measureFont`… */
  setting: string;
  sheet: string;
  /** The ruler's id (or place), for a ruler's field. */
  ruler?: string;
  from: unknown;
  to: unknown;
}

const GRID_SIZE = 'gridSizeInStud';
/** Fields keepDrawnSettingsInRange reads on a grid sheet (and the guard reads on any sheet). */
const GRID_FIELDS: ReadonlySet<string> = new Set([GRID_SIZE, 'gridThickness', 'subGridThickness', 'subDivisionNumber', 'cellIndexFont', 'cellIndexCorner']);
/** Fields it reads only on a linear ruler, and only on a circular one. */
const LINEAR_FIELDS: ReadonlySet<string> = new Set(['point1', 'point2', 'offsetDistance']);
const CIRCULAR_FIELDS: ReadonlySet<string> = new Set(['center', 'radius']);

/** The kind of sheet a field belongs to, for the clamp and the summary. */
const sheetKindOf = (field: string): 'grid' | 'area' | 'sheet' => (GRID_FIELDS.has(field) ? 'grid' : field === 'areaCellSize' ? 'area' : 'sheet');

/** What keepDrawnSettingsInRange makes of one sheet field. */
function clampSheetField(field: string, v: unknown): unknown {
  const kind = sheetKindOf(field);
  const sheet = { type: kind === 'sheet' ? 'brick' : kind, rulerItems: [], [field]: v };
  const out = keepDrawnSettingsInRange({ layers: [sheet] } as unknown as BbmMap).layers[0] as unknown as Record<string, unknown>;
  return out[field];
}

/** What keepDrawnSettingsInRange makes of one ruler field (`kind`: the ruler's). */
function clampRulerField(field: string, v: unknown, kind: unknown): unknown {
  const k = LINEAR_FIELDS.has(field) ? 'linear' : CIRCULAR_FIELDS.has(field) ? 'circular' : kind === 'linear' ? 'linear' : 'circular';
  const sheet = { type: 'ruler', rulerItems: [{ kind: k, [field]: v }] };
  const out = keepDrawnSettingsInRange({ layers: [sheet] } as unknown as BbmMap).layers[0] as unknown as { rulerItems: Record<string, unknown>[] };
  return out.rulerItems[0]![field];
}

/** The value to write for a field out of range: the clamp's, or undefined (remove it) when that is still out of range. */
function inRange(v: unknown, rule: Rule, clamp: (v: unknown) => unknown): unknown {
  if (v instanceof Y.AbstractType) return undefined;
  const c = clamp(v);
  return c !== undefined && rule(c) ? c : undefined;
}

/** A plain object (a ruler stored as JSON in shape-1 documents). */
const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Y.AbstractType) && !(v instanceof Uint8Array);

function clampSheet(sheetId: string, layer: Y.Map<unknown>, note: (c: ValueChange) => void): void {
  for (const [field, rule] of Object.entries(SHEET_RULES)) {
    const v = layer.get(field);
    if (v === undefined || rule(v)) continue;
    const to = inRange(v, rule, (x) => clampSheetField(field, x));
    if (to === undefined) layer.delete(field);
    else layer.set(field, to);
    note({ setting: `${sheetKindOf(field)}.${field}`, sheet: sheetId, from: v, to });
  }
  if (layer.get('type') === 'grid' && !validGridSize(layer.get(GRID_SIZE))) {
    // Required on a grid: the default when the clamp has nothing.
    const v = layer.get(GRID_SIZE);
    const to = inRange(v, validGridSize, (x) => clampSheetField(GRID_SIZE, x)) ?? DRAWN_LIMITS.gridSizeInStud.fallback;
    layer.set(GRID_SIZE, to);
    note({ setting: `grid.${GRID_SIZE}`, sheet: sheetId, from: v, to });
  }
  const arr = layer.get('rulerItems');
  if (!(arr instanceof Y.Array)) return;
  const items = arr.toArray();
  items.forEach((r, i) => {
    if (r instanceof Y.Map) {
      const key = typeof r.get('id') === 'string' ? (r.get('id') as string) : `#${i}`;
      for (const [field, rule] of Object.entries(RULER_RULES)) {
        const v = r.get(field);
        if (v === undefined || rule(v)) continue;
        const to = inRange(v, rule, (x) => clampRulerField(field, x, r.get('kind')));
        if (to === undefined) r.delete(field);
        else r.set(field, to);
        note({ setting: `ruler.${field}`, sheet: sheetId, ruler: key, from: v, to });
      }
      return;
    }
    if (!isPlain(r)) return;
    // A shape-1 ruler is one JSON value: the entry is replaced, in its place,
    // by the same object with the fields out of range fixed.
    let next: Record<string, unknown> | null = null;
    const key = typeof r.id === 'string' ? r.id : `#${i}`;
    for (const [field, rule] of Object.entries(RULER_RULES)) {
      const v = r[field];
      if (v === undefined || rule(v)) continue;
      next ??= { ...r };
      const to = inRange(v, rule, (x) => clampRulerField(field, x, r.kind));
      if (to === undefined) delete next[field];
      else next[field] = to;
      note({ setting: `ruler.${field}`, sheet: sheetId, ruler: key, from: v, to });
    }
    if (next) {
      arr.delete(i, 1);
      arr.insert(i, [next]);
    }
  });
}

export interface DocClamp {
  /** The Yjs update that puts the document in range; null when it already is. */
  update: Uint8Array | null;
  changes: ValueChange[];
  /** What is still out of range afterwards (nothing, unless the document is damaged in a way the guard reads differently). */
  left: string[];
}

/**
 * Put every drawing setting of `doc` in range, in one transaction (see the
 * top of the file). The doc's own update listeners see it as any edit.
 */
export function clampDocDrawing(doc: Y.Doc, origin: unknown = CLAMP_ORIGIN): DocClamp {
  if (drawingProblems(doc).size === 0) return { update: null, changes: [], left: [] };
  const changes: ValueChange[] = [];
  const parts: Uint8Array[] = [];
  const onUpdate = (u: Uint8Array) => parts.push(u);
  doc.on('update', onUpdate);
  try {
    doc.transact(() => {
      const layerData = doc.getMap<unknown>('layerData');
      layerData.forEach((layer, id) => {
        if (layer instanceof Y.Map) clampSheet(id, layer, (c) => changes.push(c));
      });
    }, origin);
  } finally {
    doc.off('update', onUpdate);
  }
  const update = parts.length === 0 ? null : parts.length === 1 ? parts[0]! : Y.mergeUpdates(parts);
  return { update, changes, left: [...drawingProblems(doc)] };
}

// ---- the database ------------------------------------------------------------

export type FixTarget = 'layout' | 'module' | 'module_version' | 'catalog_version';

/** What the fix does to one document (reported as it goes; never kept). */
export interface FixedItem {
  target: FixTarget;
  id: string;
  /** The layout or module's title, the module and version, or the catalog item and version. */
  label: string;
  changes: ValueChange[];
  left: string[];
  updateBytes: number;
}

export interface TargetCount {
  checked: number;
  changed: number;
  values: number;
  /** Documents that couldn't be read (left as they are). */
  unreadable: number;
}

export interface FixSummary {
  apply: boolean;
  layouts: TargetCount;
  modules: TargetCount;
  moduleVersions: TargetCount;
  catalogVersions: TargetCount;
  /** Values changed, by setting (`grid.subDivisionNumber`: 3). */
  bySetting: Record<string, number>;
  /** Documents with something still out of range afterwards (should be none). */
  notClean: number;
  ms: number;
}

export interface FixOptions {
  /** Write the fix (false: only report what it would change). */
  apply: boolean;
  /** The live room's doc of a layout open on this server, if any: the fix goes into it. */
  liveDoc?: ((layoutId: string) => Y.Doc | undefined) | undefined;
  /** Each document the fix changes (or would). */
  onItem?: ((item: FixedItem) => void) | undefined;
  /** Rows read per query. */
  pageSize?: number;
  now?: () => number;
}

const emptyCount = (): TargetCount => ({ checked: 0, changed: 0, values: 0, unreadable: 0 });

/** A document from its snapshot and stored updates, or null when the snapshot can't be read. */
function loadDoc(snapshot: Uint8Array | null, updates: Iterable<Uint8Array>, where: string): Y.Doc | null {
  const doc = new Y.Doc();
  try {
    if (snapshot && snapshot.length > 0) Y.applyUpdate(doc, snapshot);
  } catch {
    doc.destroy();
    return null;
  }
  // Corrupt or too costly to apply: skipped, as DocSession.hydrate does.
  for (const u of updates) applyStoredUpdate(doc, u, where);
  return doc;
}

/** Ids of a table a page at a time (keyset), so no query holds more than a page. */
function* pages(sqlite: Database.Database, sql: string, pageSize: number): Generator<string> {
  const stmt = sqlite.prepare(sql);
  let after = '';
  for (;;) {
    const rows = stmt.all(after, pageSize) as { id: string }[];
    if (rows.length === 0) return;
    for (const r of rows) yield r.id;
    after = rows[rows.length - 1]!.id;
  }
}

/**
 * Run the fix over the whole database (see the top of the file). With
 * `apply: false` nothing is written and the summary says what would change.
 */
export function clampDrawingValues(sqlite: Database.Database, opts: FixOptions): FixSummary {
  const started = Date.now();
  const now = opts.now ?? Date.now;
  const pageSize = opts.pageSize ?? 200;
  const summary: FixSummary = {
    apply: opts.apply,
    layouts: emptyCount(),
    modules: emptyCount(),
    moduleVersions: emptyCount(),
    catalogVersions: emptyCount(),
    bySetting: {},
    notClean: 0,
    ms: 0,
  };
  const record = (count: TargetCount, item: FixedItem) => {
    count.changed += 1;
    count.values += item.changes.length;
    for (const c of item.changes) summary.bySetting[c.setting] = (summary.bySetting[c.setting] ?? 0) + 1;
    if (item.left.length > 0) summary.notClean += 1;
    opts.onItem?.(item);
  };

  // Layouts: the live document is the snapshot plus its stored updates.
  {
    const row = sqlite.prepare('select title, doc_snapshot from layouts where id = ?');
    const updates = sqlite.prepare("select update_bytes from layout_updates where layout_id = ? and doc = 'main' order by id");
    const store = sqlite.prepare("insert into layout_updates (layout_id, doc, update_bytes, created_at) values (?, 'main', ?, ?)");
    for (const id of pages(sqlite, 'select id from layouts where id > ? order by id limit ?', pageSize)) {
      const r = row.get(id) as { title: string; doc_snapshot: Buffer } | undefined;
      if (!r) continue;
      summary.layouts.checked += 1;
      const live = opts.liveDoc?.(id);
      let doc: Y.Doc | null;
      if (live && opts.apply) doc = live;
      else if (live) {
        doc = new Y.Doc();
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(live));
      } else {
        // One stored update in memory at a time.
        const stored = function* () {
          for (const u of updates.iterate(id) as IterableIterator<{ update_bytes: Buffer }>) yield new Uint8Array(u.update_bytes);
        };
        doc = loadDoc(new Uint8Array(r.doc_snapshot), stored(), `layout ${id}`);
      }
      if (!doc) {
        summary.layouts.unreadable += 1;
        continue;
      }
      try {
        const fix = clampDocDrawing(doc);
        if (!fix.update) continue;
        // In the live room, the room's own listener stores and sends it.
        if (opts.apply && doc !== live) store.run(id, Buffer.from(fix.update), now());
        record(summary.layouts, { target: 'layout', id, label: r.title, changes: fix.changes, left: fix.left, updateBytes: fix.update.length });
      } finally {
        if (doc !== live) doc.destroy();
      }
    }
  }

  // Snapshots on their own: the fixed one is the old merged with the fix.
  const snapshots = (
    count: TargetCount,
    target: FixTarget,
    idsSql: string,
    rowSql: string,
    write: Database.Statement,
    label: (r: Record<string, unknown>) => string,
    bumpVersion: boolean,
  ) => {
    const row = sqlite.prepare(rowSql);
    for (const id of pages(sqlite, idsSql, pageSize)) {
      const r = row.get(id) as ({ doc_snapshot: Buffer | null } & Record<string, unknown>) | undefined;
      if (!r || !r.doc_snapshot) continue;
      count.checked += 1;
      const snapshot = new Uint8Array(r.doc_snapshot);
      const doc = loadDoc(snapshot, [], `${target} ${id}`);
      if (!doc) {
        count.unreadable += 1;
        continue;
      }
      try {
        const fix = clampDocDrawing(doc);
        if (!fix.update) continue;
        if (opts.apply) {
          const merged = Buffer.from(Y.mergeUpdates([snapshot, fix.update]));
          if (bumpVersion) write.run(merged, now(), id);
          else write.run(merged, id);
        }
        record(count, { target, id, label: label(r), changes: fix.changes, left: fix.left, updateBytes: fix.update.length });
      } finally {
        doc.destroy();
      }
    }
  };

  // A module's new contents: a new doc_version, so every app fetches them again.
  snapshots(
    summary.modules,
    'module',
    'select id from modules where id > ? order by id limit ?',
    'select title, doc_snapshot from modules where id = ?',
    sqlite.prepare('update modules set doc_snapshot = ?, doc_version = doc_version + 1, updated_at = ? where id = ?'),
    (r) => String(r.title),
    true,
  );
  snapshots(
    summary.moduleVersions,
    'module_version',
    'select id from module_versions where id > ? order by id limit ?',
    'select v.doc_snapshot, v.version, m.title from module_versions v left join modules m on m.id = v.module_id where v.id = ?',
    sqlite.prepare('update module_versions set doc_snapshot = ? where id = ?'),
    (r) => `${String(r.title)} v${String(r.version)}`,
    false,
  );
  snapshots(
    summary.catalogVersions,
    'catalog_version',
    "select v.id from catalog_item_versions v join catalog_items i on i.id = v.item_id where i.kind in ('layout', 'module') and v.id > ? order by v.id limit ?",
    'select v.doc_snapshot, v.version, i.title, i.kind from catalog_item_versions v join catalog_items i on i.id = v.item_id where v.id = ?',
    sqlite.prepare('update catalog_item_versions set doc_snapshot = ? where id = ?'),
    (r) => `${String(r.kind)} ${String(r.title)} v${String(r.version)}`,
    false,
  );

  summary.ms = Date.now() - started;
  return summary;
}

/** The summary in a few lines, for the log and the dry run. */
export function summaryLines(s: FixSummary): string[] {
  const verb = s.apply ? 'changed' : 'would change';
  const line = (name: string, c: TargetCount) =>
    `  ${name}: ${c.checked} checked, ${c.changed} ${verb} (${c.values} values)${c.unreadable ? `, ${c.unreadable} unreadable (left as they are)` : ''}`;
  const settings = Object.entries(s.bySetting).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return [
    `${CLAMP_FIX_ID}${s.apply ? '' : ' (dry run, nothing written)'}: ${s.layouts.changed + s.modules.changed + s.moduleVersions.changed + s.catalogVersions.changed} documents, ${s.layouts.values + s.modules.values + s.moduleVersions.values + s.catalogVersions.values} values, in ${s.ms} ms`,
    line('layouts', s.layouts),
    line('modules', s.modules),
    line('module versions', s.moduleVersions),
    line('catalog versions (layouts, modules)', s.catalogVersions),
    `  by setting: ${settings.length ? settings.map(([k, n]) => `${k} ${n}`).join(', ') : 'none'}`,
    ...(s.notClean ? [`  WARNING: ${s.notClean} documents still have something out of range afterwards`] : []),
  ];
}
