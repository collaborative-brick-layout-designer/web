// Bring back bricks a layout lost while it was merged (see restoreDeletedBricks.ts).
//
//   node dist/ops/restoreDeletedBricksCli.js --db <live.sqlite> --reference <backup.sqlite> \
//     --layouts <id>,<id>,... [--witness-db <before-repair.sqlite> --witness <id>=<witness id>,...] \
//     [--report plan.json] [--export-dir dir] [--apply --expect <fingerprint>]
//
// --witness names, per layout, a doc in --witness-db that held the layout's
// items when the merge began (the other layout's doc before the unmerge
// repair); only bricks alive there come back. Without one, every brick
// deleted since the reference does.
//
// Same rules as unmergeLayoutsCli: without --apply it only reads and prints
// the plan and its fingerprint; --apply needs that fingerprint and the
// server stopped. It writes each restored doc as the new snapshot, clears
// the layout's pending updates, and logs a `layout_restore_bricks` audit
// event per layout, in one transaction.

import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { refuseWhileRunning } from './serverLock.js';
import * as Y from 'yjs';
import { planRestore, restoreFingerprint, type RestoreInput, type RestorePlan } from './restoreDeletedBricks.js';
import { currentBytes, exportDoc, loadRows, safeName } from './unmergeLayoutsCli.js';

function printPlan(p: RestorePlan): void {
  const out = (s = '') => process.stdout.write(`${s}\n`);
  out(`=== ${p.title} (${p.id})`);
  out(`  restore (${p.restored.length}):`);
  const byLayer = new Map<string, RestorePlan['restored']>();
  for (const r of p.restored) byLayer.set(`"${r.layerName}" [${r.layerId}]`, [...(byLayer.get(`"${r.layerName}" [${r.layerId}]`) ?? []), r]);
  for (const [layer, list] of byLayer) {
    out(`    ${layer}: ${list.length}`);
    for (const r of list) out(`      + ${r.partNumber} id ${r.id} at (${r.x}, ${r.y}) rot ${r.orientation}, index ${r.index}, ${r.links} links`);
  }
  out(`  neighbours relinked: ${p.relinked}`);
  if (p.groups.length) out(`  groups back: ${p.groups.join(', ')}`);
  if (p.modules.length) out(`  modules listing them again: ${p.modules.join(', ')}`);
  out(`  left alone (${p.skipped.length}):`);
  for (const s of p.skipped) out(`    - [${s.layerId}] ${s.partNumber} id ${s.id}: ${s.why}`);
  out(`  update: ${p.update.length} bytes, sha256 ${p.fingerprint}`);
  out();
}

export function main(argv = process.argv.slice(2)): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string' },
      reference: { type: 'string' },
      layouts: { type: 'string' },
      'witness-db': { type: 'string' },
      witness: { type: 'string' },
      report: { type: 'string' },
      'export-dir': { type: 'string' },
      apply: { type: 'boolean', default: false },
      expect: { type: 'string' },
    },
  });
  if (!values.db || !values.reference || !values.layouts || (!!values.witness !== !!values['witness-db'])) {
    process.stderr.write(
      'usage: --db <live.sqlite> --reference <backup.sqlite> --layouts <id,...> [--witness-db <db> --witness <id>=<id>,...] [--report f.json] [--export-dir d] [--apply --expect <fingerprint>]\n',
    );
    return 2;
  }
  const ids = values.layouts.split(',').map((s) => s.trim()).filter(Boolean);
  const witnessOf = new Map<string, string>();
  for (const pair of (values.witness ?? '').split(',').filter(Boolean)) {
    const [a, b] = pair.split('=').map((s) => s.trim());
    if (!a || !b) {
      process.stderr.write(`bad --witness entry: ${pair}\n`);
      return 2;
    }
    witnessOf.set(a, b);
  }
  const live = new Database(values.db, { readonly: !values.apply, fileMustExist: true });
  const ref = new Database(values.reference, { readonly: true, fileMustExist: true });
  const wit = values['witness-db'] ? new Database(values['witness-db'], { readonly: true, fileMustExist: true }) : null;
  try {
    const rows = loadRows(live, ids);
    const refRows = loadRows(ref, ids);
    const witRows = wit ? loadRows(wit, [...witnessOf.values()]) : new Map();
    const missing = [
      ...ids.filter((id) => !rows.has(id)).map((id) => `${id} (live)`),
      ...ids.filter((id) => !refRows.has(id)).map((id) => `${id} (reference)`),
      ...[...witnessOf.values()].filter((id) => !witRows.has(id)).map((id) => `${id} (witness)`),
    ];
    if (missing.length) {
      process.stderr.write(`no such layout: ${missing.join(', ')}\n`);
      return 2;
    }
    const inputs: RestoreInput[] = ids.map((id) => {
      const row = rows.get(id)!;
      const w = witnessOf.get(id);
      return {
        id,
        title: row.title,
        current: currentBytes(live, row),
        reference: currentBytes(ref, refRows.get(id)!),
        witness: w && wit ? currentBytes(wit, witRows.get(w)!) : null,
      };
    });
    const plans = inputs.map(planRestore);
    for (const p of plans) printPlan(p);
    const fingerprint = restoreFingerprint(plans);
    process.stdout.write(`plan fingerprint: ${fingerprint}\n`);

    if (values['export-dir']) {
      const dir = values['export-dir'];
      mkdirSync(dir, { recursive: true });
      for (const [i, p] of plans.entries()) {
        const input = inputs[i]!;
        exportDoc(dir, `${safeName(p.title)}-before`, input.current);
        exportDoc(dir, `${safeName(p.title)}-after`, Y.mergeUpdates([input.current, p.update]));
        exportDoc(dir, `${safeName(p.title)}-reference`, input.reference);
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
            "insert into audit_events (layout_id, user_id, event_type, payload, doc_version, created_at, actor_label) values (?, null, 'layout_restore_bricks', ?, ?, ?, 'ops')",
          )
          .run(
            p.id,
            JSON.stringify({ restored: p.restored.length, relinked: p.relinked, groups: p.groups.length, fingerprint: p.fingerprint }),
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
    wit?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main());
