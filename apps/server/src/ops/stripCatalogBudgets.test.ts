// The one-time fix strip-catalog-budgets (stripCatalogBudgets.ts, run by
// dataFixes.ts): published layout copies stored with a budget lose it, and
// nothing else changes.
//   - a copy with a budget is stored without it (the part numbers are gone
//     from its bytes) and is otherwise the same layout; a copy without one
//     keeps its bytes;
//   - an owner's own layout with a budget, a module and a venue aren't
//     touched, and no row is deleted;
//   - a copy that can't be read is counted and left as it is;
//   - the dry run writes nothing; the fix runs only when asked, once, after
//     a copy of the database, with one audit event; a second run changes
//     nothing; stopped part-way, nothing was written.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUDGET_LIMITS_KEY, createDefaultLayoutDoc, decodeDoc, docToBbm, encodeDoc, exportBbmFromDoc, exportSidecarFromDoc, importSidecarIntoDoc, readBudgetLimitsFromDoc, seedFromBbm } from '@cld/ydoc';
import type { Sidecar } from '@cld/bbm';
import { resetDb } from '../test/helpers.js';
import { sqlite } from '../db/index.js';
import { publishedDoc } from '../routes/catalogDocs.js';
import { backupBeforeFix, preFixBackupName } from '../workers/backup.js';
import { askedFixes, runDataFixes } from './dataFixes.js';
import { CLAMP_FIX_ID } from './clampDrawingValues.js';
import { DATA_FIX_EVENT, STRIP_BUDGETS_FIX_ID, stripCatalogBudgets, withoutBudget } from './stripCatalogBudgets.js';

/** Part numbers nothing else in a document would spell. */
const BUDGET = { 'SECRET4515.1': 12, 'HIDDEN2865.7': 300 };
const SECRETS = Object.keys(BUDGET);
const VIEWS = [{ name: 'Yard', x: 1, y: 2, zoom: 3 }];

/** A published layout copy as catalogDocs.ts stored one: with the budget (before it was left out) or without. */
function copy(budget?: Record<string, number>): Buffer {
  const out = seedFromBbm(docToBbm(createDefaultLayoutDoc()));
  importSidecarIntoDoc(out, { schemaVersion: 1, bbmHashSha256: '', views: VIEWS, ...(budget ? { budgetLimits: budget } : {}) } as unknown as Sidecar);
  const bytes = Buffer.from(encodeDoc(out));
  out.destroy();
  return bytes;
}

/** What a stored document says: its map, its sidecar and its budget. */
function read(bytes: Uint8Array) {
  const doc = decodeDoc(bytes);
  try {
    return { map: exportBbmFromDoc(doc), sidecar: exportSidecarFromDoc(doc), budget: readBudgetLimitsFromDoc(doc), hasKey: doc.getMap('meta').has(BUDGET_LIMITS_KEY) };
  } finally {
    doc.destroy();
  }
}

const holdsSecrets = (bytes: Uint8Array) => SECRETS.some((s) => Buffer.from(bytes).includes(s));

describe('a stored copy without its budget', () => {
  it('is the same layout, with the budget and its part numbers gone', () => {
    const before = copy(BUDGET);
    expect(read(before).budget).toEqual(BUDGET);
    expect(holdsSecrets(before)).toBe(true);
    const out = withoutBudget(before);
    if (out.state !== 'stripped') throw new Error(out.state);
    const after = read(out.bytes);
    expect(after.hasKey).toBe(false);
    expect(after.budget).toBeUndefined();
    expect(holdsSecrets(out.bytes)).toBe(false);
    expect(after.map).toEqual(read(before).map);
    const { budgetLimits: _gone, ...rest } = read(before).sidecar!;
    expect(after.sidecar).toEqual(rest);
    expect(after.sidecar!.views).toEqual(VIEWS);
    // What people are handed is still that layout.
    expect(read(publishedDoc(out.bytes)).map).toEqual(read(before).map);
    // Again: nothing left to do.
    expect(withoutBudget(out.bytes)).toEqual({ state: 'none' });
  });

  it('leaves a copy with no budget, and an empty budget goes too', () => {
    expect(withoutBudget(copy())).toEqual({ state: 'none' });
    const empty = withoutBudget(copy({}));
    expect(empty.state).toBe('stripped');
  });

  it('says so when the bytes are not a document it can read', () => {
    expect(withoutBudget(Buffer.from(`not a document ${BUDGET_LIMITS_KEY}`))).toEqual({ state: 'unreadable' });
    expect(withoutBudget(new Uint8Array(0))).toEqual({ state: 'unreadable' });
    const whole = copy(BUDGET);
    expect(withoutBudget(whole.subarray(0, whole.length - 40))).toEqual({ state: 'unreadable' });
    // A change that waits for one the document doesn't have.
    const a = new Y.Doc();
    a.getMap('meta').set('x', 1);
    const first = Y.encodeStateVector(a);
    a.getMap('meta').set(BUDGET_LIMITS_KEY, new Y.Map());
    const second = Y.encodeStateVector(a);
    a.getMap('meta').set('y', 2);
    expect(first.length).toBeGreaterThan(0);
    expect(withoutBudget(Y.encodeStateAsUpdate(a, second))).toEqual({ state: 'unreadable' });
  });
});

describe('the one-time fix strip-catalog-budgets', () => {
  const OWNER = 'owner-1';
  const dirs: string[] = [];

  beforeEach(() => {
    sqlite.exec('DELETE FROM catalog_item_versions; DELETE FROM catalog_items;');
    resetDb();
    sqlite.exec('DELETE FROM data_fixes');
    sqlite.prepare('INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)').run(OWNER, 'owner@example.com', 'Owner', Date.now());
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    sqlite.exec('DELETE FROM catalog_item_versions; DELETE FROM catalog_items;');
  });

  function item(kind: 'layout' | 'module' | 'venue', status: string, versions: { status: string; bytes: Buffer | null }[]): string[] {
    const id = randomUUID();
    const now = Date.now();
    sqlite
      .prepare('INSERT INTO catalog_items (id, kind, source_id, owner_user_id, title, status, public_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .run(id, kind, randomUUID(), OWNER, `${kind} item`, status, now, now);
    return versions.map((v, i) => {
      const vid = randomUUID();
      sqlite
        .prepare('INSERT INTO catalog_item_versions (id, item_id, version, status, note, doc_snapshot, thumbnail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(vid, id, i + 1, v.status, 'a note', v.bytes, Buffer.from('picture'), now);
      return vid;
    });
  }

  function ownLayout(title: string, snapshot: Buffer, updates: Uint8Array[] = []): string {
    const id = randomUUID();
    const now = Date.now();
    sqlite
      .prepare('INSERT INTO layouts (id, title, created_by, owner_user_id, created_at, updated_at, doc_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, title, OWNER, OWNER, now, now, snapshot);
    for (const u of updates) sqlite.prepare("INSERT INTO layout_updates (layout_id, doc, update_bytes, created_at) VALUES (?, 'main', ?, ?)").run(id, Buffer.from(u), now);
    return id;
  }

  /** Every row of every table a document lives in, whole. */
  function dump(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const t of ['catalog_items', 'catalog_item_versions', 'layouts', 'layout_updates', 'modules', 'module_versions']) {
      for (const r of sqlite.prepare(`select * from ${t}`).all() as Record<string, unknown>[]) {
        out[`${t} ${String(r.id)}`] = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString('hex') : v]));
      }
    }
    return out;
  }
  const stored = (versionId: string) => (sqlite.prepare('select doc_snapshot from catalog_item_versions where id = ?').get(versionId) as { doc_snapshot: Buffer }).doc_snapshot;
  const audits = () => sqlite.prepare('select * from audit_events where event_type = ?').all(DATA_FIX_EVENT) as { resource_kind: string; resource_id: string; user_id: string | null; payload: string }[];

  /** Published copies of every kind, and an owner's own layouts. */
  function world() {
    // Old copies with a budget: the public version, one waiting for review,
    // a declined one, and an item its owner took back.
    const [publicV, waitingV] = item('layout', 'public', [
      { status: 'public', bytes: copy(BUDGET) },
      { status: 'in_review', bytes: copy({ ...BUDGET, 'SECRET4515.1': 99 }) },
    ]);
    const [declinedV] = item('layout', 'declined', [{ status: 'declined', bytes: copy(BUDGET) }]);
    const [withdrawnV] = item('layout', 'withdrawn', [{ status: 'public', bytes: copy(BUDGET) }]);
    // Copies without one (published since, or a layout that had none), and a version with no document.
    const [cleanV, emptyV] = item('layout', 'public', [
      { status: 'public', bytes: copy() },
      { status: 'in_review', bytes: null },
    ]);
    // Not a layout copy: left alone whatever it holds.
    const [moduleV] = item('module', 'public', [{ status: 'public', bytes: copy(BUDGET) }]);
    const [venueV] = item('venue', 'public', [{ status: 'public', bytes: Buffer.from(JSON.stringify({ name: 'Hall', [BUDGET_LIMITS_KEY]: BUDGET }), 'utf8') }]);
    // The owner's own layout, budget in its snapshot; and one whose budget came in a later edit.
    const own = ownLayout('Mine', copy(BUDGET));
    const later = decodeDoc(copy());
    const before = Y.encodeStateVector(later);
    const y = new Y.Map<number>();
    later.getMap('meta').set(BUDGET_LIMITS_KEY, y);
    y.set('SECRET4515.1', 5);
    const ownEdited = ownLayout('Mine, edited', copy(), [Y.encodeStateAsUpdate(later, before)]);
    return { withBudget: [publicV!, waitingV!, declinedV!, withdrawnV!], cleanV: cleanV!, emptyV: emptyV!, moduleV: moduleV!, venueV: venueV!, own, ownEdited };
  }

  it('reports in a dry run what it would change, writing nothing', () => {
    world();
    const before = dump();
    const s = stripCatalogBudgets(sqlite, { apply: false });
    expect(s).toMatchObject({ apply: false, checked: 5, changed: 4, unreadable: 0 });
    expect(dump()).toEqual(before);
    expect(audits()).toEqual([]);
  });

  it('removes the budget from the stored layout copies and touches nothing else', () => {
    const w = world();
    const before = dump();
    const s = stripCatalogBudgets(sqlite, { apply: true, pageSize: 2 });
    expect(s).toMatchObject({ apply: true, checked: 5, changed: 4, unreadable: 0 });
    expect(s.bytesAfter).toBeLessThan(s.bytesBefore);
    const after = dump();
    // The same rows; only those four copies' documents differ.
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    const differ = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
    expect(differ.sort()).toEqual(w.withBudget.map((id) => `catalog_item_versions ${id}`).sort());
    for (const k of differ) {
      const { doc_snapshot: _a, ...restAfter } = after[k] as Record<string, unknown>;
      const { doc_snapshot: _b, ...restBefore } = before[k] as Record<string, unknown>;
      expect(restAfter).toEqual(restBefore);
    }
    for (const id of w.withBudget) {
      const now = read(stored(id));
      expect(now.hasKey).toBe(false);
      expect(holdsSecrets(stored(id))).toBe(false);
      expect(now.map).toEqual(read(copy()).map);
      expect(now.sidecar!.views).toEqual(VIEWS);
    }
    // The owner's own layouts keep their budget.
    const own = sqlite.prepare('select doc_snapshot from layouts where id = ?').get(w.own) as { doc_snapshot: Buffer };
    expect(read(own.doc_snapshot).budget).toEqual(BUDGET);
    expect(sqlite.prepare('select count(*) as n from layout_updates where layout_id = ?').get(w.ownEdited)).toEqual({ n: 1 });
    // A module and a venue aren't layout copies.
    expect(read(stored(w.moduleV)).budget).toEqual(BUDGET);
    expect(stored(w.venueV).toString('utf8')).toContain('SECRET4515.1');

    // A second run changes nothing.
    const s2 = stripCatalogBudgets(sqlite, { apply: true });
    expect(s2).toMatchObject({ checked: 5, changed: 0, unreadable: 0 });
    expect(dump()).toEqual(after);
  });

  it('counts a copy it cannot read and leaves it as it is', () => {
    const w = world();
    const whole = copy(BUDGET);
    const [garbage, cut, nothing] = item('layout', 'public', [
      { status: 'public', bytes: Buffer.from(`not a document ${BUDGET_LIMITS_KEY} SECRET4515.1`) },
      { status: 'public', bytes: Buffer.from(whole.subarray(0, whole.length - 40)) },
      { status: 'public', bytes: Buffer.alloc(0) },
    ]);
    const before = dump();
    const s = stripCatalogBudgets(sqlite, { apply: true });
    expect(s).toMatchObject({ checked: 8, changed: 4, unreadable: 3 });
    const after = dump();
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const id of [garbage!, cut!, nothing!]) expect(after[`catalog_item_versions ${id}`]).toEqual(before[`catalog_item_versions ${id}`]);
    for (const id of w.withBudget) expect(read(stored(id)).hasKey).toBe(false);
  });

  it('stopped part-way, nothing was written, and it runs again from the start', () => {
    const w = world();
    const before = dump();
    expect(() =>
      stripCatalogBudgets(sqlite, {
        apply: true,
        inTransaction: () => {
          throw new Error('stopped');
        },
      }),
    ).toThrow('stopped');
    expect(dump()).toEqual(before);
    expect(read(stored(w.withBudget[0]!)).budget).toEqual(BUDGET);
    expect(stripCatalogBudgets(sqlite, { apply: true })).toMatchObject({ changed: 4 });
  });

  it('runs at start only when asked, after a copy of the database, once, with one audit event', () => {
    const w = world();
    const before = dump();
    const backups = mkdtempSync(join(tmpdir(), 'cld-fix-'));
    dirs.push(backups);
    const log: string[] = [];
    const backup = (fixId: string) => {
      backupBeforeFix(sqlite, fixId, backups, (l) => log.push(l));
    };

    /** What the start log said about this fix. */
    const said = () => log.filter((l) => l.includes(STRIP_BUDGETS_FIX_ID));
    // Not asked: one line that says how many, nothing written, no copy made.
    let run = runDataFixes(sqlite, askedFixes(undefined), (l) => log.push(l), undefined, backup);
    expect(run).toEqual({ ran: [], pending: [STRIP_BUDGETS_FIX_ID] });
    expect(said()).toHaveLength(1);
    expect(said()[0]).toContain(`not run yet: ${STRIP_BUDGETS_FIX_ID} (4 published layout copies hold a budget)`);
    expect(said()[0]).toContain('CBLD_DATA_FIX=<name>');
    // (The other fix had nothing to do here, and says so.)
    expect(log).toHaveLength(2);
    expect(log[0]).toBe(`[dataFix] ${CLAMP_FIX_ID}: looked, nothing to fix; recorded as done`);
    expect(dump()).toEqual(before);
    expect(readdirSync(backups)).toEqual([]);
    expect(sqlite.prepare('select id from data_fixes').all()).toEqual([{ id: CLAMP_FIX_ID }]);
    expect(audits()).toEqual([]);

    // Asked, but the database can't be copied: it doesn't run.
    log.length = 0;
    run = runDataFixes(sqlite, askedFixes(STRIP_BUDGETS_FIX_ID), (l) => log.push(l), undefined, () => {
      throw new Error('disk full');
    });
    expect(run).toEqual({ ran: [], pending: [] });
    expect(said()).toEqual([expect.stringContaining("not run, the database couldn't be copied first (disk full)")]);
    expect(dump()).toEqual(before);
    expect(sqlite.prepare('select id from data_fixes where id = ?').all(STRIP_BUDGETS_FIX_ID)).toEqual([]);

    // Asked: the copy first, then the fix, recorded, one audit event with the counts.
    log.length = 0;
    run = runDataFixes(sqlite, askedFixes(STRIP_BUDGETS_FIX_ID), (l) => log.push(l), undefined, backup);
    expect(run.ran.map((r) => r.id)).toEqual([STRIP_BUDGETS_FIX_ID]);
    expect(log.join('\n')).toContain(`copied the database to ${preFixBackupName(STRIP_BUDGETS_FIX_ID)}`);
    expect(log.findIndex((l) => l.includes('copied the database to'))).toBeLessThan(log.findIndex((l) => l.includes(`${STRIP_BUDGETS_FIX_ID}: running`)));
    expect(log.join('\n')).toMatch(/5 published layout copies checked, 4 had their budget removed/);
    for (const id of w.withBudget) expect(read(stored(id)).hasKey).toBe(false);
    const rec = sqlite.prepare('select summary from data_fixes where id = ?').get(STRIP_BUDGETS_FIX_ID) as { summary: string };
    expect(JSON.parse(rec.summary)).toMatchObject({ apply: true, checked: 5, changed: 4, unreadable: 0 });
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({ resource_kind: 'platform_settings', resource_id: `data_fix:${STRIP_BUDGETS_FIX_ID}`, user_id: null });
    expect(JSON.parse(audits()[0]!.payload)).toEqual({ fix: STRIP_BUDGETS_FIX_ID, checked: 5, changed: 4, unreadable: 0 });

    // The copy is the database as it was: the rollback.
    const path = join(backups, preFixBackupName(STRIP_BUDGETS_FIX_ID));
    expect(existsSync(path)).toBe(true);
    const old = new Database(path, { readonly: true });
    for (const id of w.withBudget) {
      const r = old.prepare('select doc_snapshot from catalog_item_versions where id = ?').get(id) as { doc_snapshot: Buffer };
      expect(r.doc_snapshot.toString('hex')).toBe((before[`catalog_item_versions ${id}`] as { doc_snapshot: string }).doc_snapshot);
    }
    expect(old.prepare('select count(*) as n from data_fixes where id = ?').get(STRIP_BUDGETS_FIX_ID)).toEqual({ n: 0 });
    old.close();

    // A copy published with a budget afterwards (it can't be; say it were): asked again, it doesn't run.
    const [lateV] = item('layout', 'public', [{ status: 'public', bytes: copy(BUDGET) }]);
    const afterRun = dump();
    log.length = 0;
    run = runDataFixes(sqlite, askedFixes(STRIP_BUDGETS_FIX_ID), (l) => log.push(l), undefined, backup);
    expect(run).toEqual({ ran: [], pending: [] });
    expect(said()).toEqual([expect.stringContaining('already ran')]);
    expect(dump()).toEqual(afterRun);
    expect(read(stored(lateV!)).budget).toEqual(BUDGET);
    expect(audits()).toHaveLength(1);
    // And once recorded, not asked: every start says it already ran, and does nothing.
    log.length = 0;
    runDataFixes(sqlite, askedFixes(''), (l) => log.push(l), undefined, backup);
    expect(said()).toEqual([expect.stringMatching(new RegExp(`^\\[dataFix\\] ${STRIP_BUDGETS_FIX_ID}: already ran on \\d{4}-.*; nothing to do$`))]);
    expect(dump()).toEqual(afterRun);
  });

  it('a server with no budget in any copy records it as done and says so', () => {
    item('layout', 'public', [{ status: 'public', bytes: copy() }]);
    const before = dump();
    const log: string[] = [];
    const run = runDataFixes(sqlite, askedFixes(undefined), (l) => log.push(l));
    expect(run).toEqual({ ran: [], pending: [] });
    expect(log).toContain(`[dataFix] ${STRIP_BUDGETS_FIX_ID}: looked, nothing to fix (0 published layout copies hold a budget); recorded as done`);
    expect(dump()).toEqual(before);
    const rec = sqlite.prepare('select summary from data_fixes where id = ?').get(STRIP_BUDGETS_FIX_ID) as { summary: string };
    expect(JSON.parse(rec.summary)).toMatchObject({ apply: false, changed: 0 });
    expect(audits()).toEqual([]);
  });
});
