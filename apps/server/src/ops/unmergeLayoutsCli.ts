// Separate layouts that were merged into each other (see unmergeLayouts.ts).
//
//   node dist/ops/unmergeLayoutsCli.js --db <live.sqlite> --reference <backup.sqlite> \
//     --layouts <id>,<id>,... [--report plan.json] [--export-dir dir] [--apply --expect <fingerprint>]
//
// Without --apply it only reads: it prints what it would remove and restore
// per layout and a fingerprint of the plan. --apply needs that fingerprint
// (--expect), so what runs is exactly what was reviewed, and the server
// stopped: an open room's in-memory doc would overwrite the repair on its
// next flush. It writes each repaired doc as the new snapshot and clears the
// layout's pending updates, as DocSession.flushSnapshot does, in one
// transaction, and logs a `layout_unmerge` audit event per layout.
//
// The reference is only read: each layout's own items and prior values come
// from it, its content is never copied over the layout.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { refuseWhileRunning } from './serverLock.js';
import * as Y from 'yjs';
import { writeBbm, writeSidecar, type Sidecar } from '@cld/bbm';
import { exportBbmFromDoc, exportSidecarFromDoc } from '@cld/ydoc';
import { planFingerprint, planUnmerge, type DocSummary, type LayoutPlan, type UnmergeInput } from './unmergeLayouts.js';

export interface Row {
  id: string;
  title: string;
  doc_snapshot: Buffer;
  doc_version: number;
}

export function currentBytes(db: Database.Database, row: Row): Uint8Array {
  const updates = db
    .prepare("select update_bytes from layout_updates where layout_id = ? and doc = 'main' order by id")
    .all(row.id) as { update_bytes: Buffer }[];
  if (updates.length === 0) return new Uint8Array(row.doc_snapshot);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, row.doc_snapshot);
  for (const u of updates) {
    try {
      Y.applyUpdate(doc, u.update_bytes);
    } catch {
      // Corrupt update: skipped, as DocSession.hydrate does.
    }
  }
  return Y.encodeStateAsUpdate(doc);
}

export function loadRows(db: Database.Database, ids: string[]): Map<string, Row> {
  const stmt = db.prepare('select id, title, doc_snapshot, doc_version from layouts where id = ?');
  const out = new Map<string, Row>();
  for (const id of ids) {
    const row = stmt.get(id) as Row | undefined;
    if (row) out.set(id, row);
  }
  return out;
}

function layerLine(s: DocSummary): string[] {
  return s.layers.map((l) => {
    const parts = [l.type];
    if (l.bricks) parts.push(`${l.bricks} bricks`);
    if (l.groups) parts.push(`${l.groups} groups`);
    if (l.textCells) parts.push(`${l.textCells} texts`);
    if (l.rulers) parts.push(`${l.rulers} rulers`);
    return `"${l.name}" [${l.id}] (${parts.join(', ')})`;
  });
}

function printPlan(p: LayoutPlan): void {
  const out = (s = '') => process.stdout.write(`${s}\n`);
  out(`=== ${p.title} (${p.id})`);
  out(`  now:      ${p.before.layers.length} layers, ${p.before.modules} modules, ${p.before.labels} labels`);
  for (const l of layerLine(p.before)) out(`            ${l}`);
  if (p.reference) {
    out(`  reference: ${p.reference.layers.length} layers, ${p.reference.modules} modules, ${p.reference.labels} labels`);
    for (const l of layerLine(p.reference)) out(`            ${l}`);
  }
  out(`  after:    ${p.after.layers.length} layers, ${p.after.modules} modules, ${p.after.labels} labels`);
  for (const l of layerLine(p.after)) out(`            ${l}`);
  out(`  remove (${p.removals.length}):`);
  for (const r of p.removals) out(`    - ${r.path}: ${r.what} <- ${r.from}`);
  out(`  restore (${p.restores.length}):`);
  for (const r of p.restores) out(`    - ${r.path}: ${r.was} -> ${r.now}`);
  if (p.unresolved.length) {
    out(`  left alone (${p.unresolved.length}):`);
    for (const u of p.unresolved) out(`    ? ${u}`);
  }
  out(`  newer than the references, by client:`);
  for (const c of p.newClients) out(`    ${c.client}: ${c.items} items${c.alsoIn.length ? `, also in ${c.alsoIn.join(', ')}` : ''}`);
  out(`  update: ${p.update.length} bytes, sha256 ${p.fingerprint}`);
  out();
}

export function exportDoc(dir: string, name: string, bytes: Uint8Array): void {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  const map = exportBbmFromDoc(doc);
  if (map) writeFileSync(join(dir, `${name}.bbm`), writeBbm(map));
  const sidecar = exportSidecarFromDoc(doc);
  if (sidecar) writeFileSync(join(dir, `${name}.bbm.bld`), writeSidecar(sidecar as Sidecar));
}

export function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_');
}

export function main(argv = process.argv.slice(2)): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string' },
      reference: { type: 'string' },
      layouts: { type: 'string' },
      report: { type: 'string' },
      'export-dir': { type: 'string' },
      apply: { type: 'boolean', default: false },
      expect: { type: 'string' },
    },
  });
  if (!values.db || !values.reference || !values.layouts) {
    process.stderr.write('usage: --db <live.sqlite> --reference <backup.sqlite> --layouts <id,id,...> [--report f.json] [--export-dir d] [--apply --expect <fingerprint>]\n');
    return 2;
  }
  const ids = values.layouts.split(',').map((s) => s.trim()).filter(Boolean);
  const live = new Database(values.db, { readonly: !values.apply, fileMustExist: true });
  const ref = new Database(values.reference, { readonly: true, fileMustExist: true });
  try {
    const rows = loadRows(live, ids);
    const refRows = loadRows(ref, ids);
    const missing = ids.filter((id) => !rows.has(id));
    if (missing.length) {
      process.stderr.write(`no such layout: ${missing.join(', ')}\n`);
      return 2;
    }
    const inputs: UnmergeInput[] = ids.map((id) => {
      const row = rows.get(id)!;
      const r = refRows.get(id);
      return { id, title: row.title, current: currentBytes(live, row), reference: r ? currentBytes(ref, r) : null };
    });
    const plans = planUnmerge(inputs);
    for (const p of plans) printPlan(p);
    const fingerprint = planFingerprint(plans);
    process.stdout.write(`plan fingerprint: ${fingerprint}\n`);

    if (values['export-dir']) {
      const dir = values['export-dir'];
      mkdirSync(dir, { recursive: true });
      for (const [i, p] of plans.entries()) {
        const input = inputs[i]!;
        const after = Y.mergeUpdates([input.current, p.update]);
        exportDoc(dir, `${safeName(p.title)}-before`, input.current);
        exportDoc(dir, `${safeName(p.title)}-after`, after);
        if (input.reference) exportDoc(dir, `${safeName(p.title)}-reference`, input.reference);
      }
    }
    if (values.report) {
      const json = plans.map(({ update, ...p }) => ({ ...p, updateBytes: update.length }));
      writeFileSync(values.report, JSON.stringify({ fingerprint, plans: json }, null, 2));
    }

    if (!values.apply) {
      process.stdout.write('dry run: nothing written. Stop the server and rerun with --apply --expect <fingerprint> to apply.\n');
      return 0;
    }
    const running = refuseWhileRunning(values.db);
    if (running) {
      process.stderr.write(running);
      return 4;
    }
    if (values.expect !== fingerprint) {
      process.stderr.write(`refusing: --expect ${values.expect ?? '(none)'} doesn't match this plan (${fingerprint}). Review the dry run again.\n`);
      return 3;
    }
    const now = Date.now();
    const write = live.transaction(() => {
      for (const [i, p] of plans.entries()) {
        if (p.update.length === 0) continue;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, inputs[i]!.current);
        Y.applyUpdate(doc, p.update);
        const row = rows.get(p.id)!;
        live
          .prepare('update layouts set doc_snapshot = ?, doc_version = ?, updated_at = ? where id = ?')
          .run(Buffer.from(Y.encodeStateAsUpdate(doc)), row.doc_version + 1, now, p.id);
        live.prepare("delete from layout_updates where layout_id = ? and doc = 'main'").run(p.id);
        live
          .prepare(
            "insert into audit_events (layout_id, user_id, event_type, payload, doc_version, created_at, actor_label) values (?, null, 'layout_unmerge', ?, ?, ?, 'ops')",
          )
          .run(
            p.id,
            JSON.stringify({ removed: p.removals.length, restored: p.restores.length, fingerprint: p.fingerprint }),
            row.doc_version + 1,
            now,
          );
      }
    });
    write();
    process.stdout.write(`applied ${fingerprint} to ${plans.filter((p) => p.update.length).length} layouts.\n`);
    return 0;
  } finally {
    live.close();
    ref.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
