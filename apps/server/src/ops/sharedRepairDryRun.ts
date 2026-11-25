// What the repair of shared modules' extra copies (sharedModules/repair.ts)
// would do to every layout of a database, counted, with the repair's own
// code and nothing written: the numbers of ops/sharedRepairDryRunCli.ts.

import { asc, eq, gt, and } from 'drizzle-orm';
import * as Y from 'yjs';
import { db, schema } from '../db/index.js';
import { examine, type SkipReason } from '../sharedModules/repair.js';
import { forgetSharedGeometry } from '../ws/sharedGeometry.js';
import { trimPending } from '../ws/pending.js';
import { applyStoredUpdate } from '../ws/yjsWork.js';

export interface DryRun {
  layouts: number;
  unreadable: number;
  /** Layouts with at least one module to repair; those modules; copies taken out; parts made their version's. */
  change: { layouts: number; modules: number; removed: number; restored: number };
  /** Layouts with extra copies where nothing would change; modules left as they are, by why. */
  skip: { layouts: number; modules: number; why: Partial<Record<SkipReason, number>> };
}

export async function sharedRepairDryRun(): Promise<DryRun> {
  const out: DryRun = { layouts: 0, unreadable: 0, change: { layouts: 0, modules: 0, removed: 0, restored: 0 }, skip: { layouts: 0, modules: 0, why: {} } };
  let after = '';
  for (;;) {
    const ids = await db.select({ id: schema.layouts.id }).from(schema.layouts).where(gt(schema.layouts.id, after)).orderBy(asc(schema.layouts.id)).limit(200).all();
    if (ids.length === 0) return out;
    for (const { id } of ids) {
      after = id;
      out.layouts += 1;
      const row = await db.select({ snapshot: schema.layouts.docSnapshot, ownerUserId: schema.layouts.ownerUserId, ownerOrgId: schema.layouts.ownerOrgId }).from(schema.layouts).where(eq(schema.layouts.id, id)).get();
      if (!row) continue;
      const doc = new Y.Doc();
      try {
        const bytes = row.snapshot as Uint8Array;
        if (bytes.length > 0) Y.applyUpdate(doc, bytes);
        const updates = await db.select({ u: schema.layoutUpdates.updateBytes }).from(schema.layoutUpdates).where(and(eq(schema.layoutUpdates.layoutId, id), eq(schema.layoutUpdates.doc, 'main'))).orderBy(asc(schema.layoutUpdates.id)).all();
        for (const { u } of updates) applyStoredUpdate(doc, u as Uint8Array, `layout ${id}`);
        trimPending(doc);
        const looked = (await examine(id, row, doc))?.plan();
        if (!looked) continue;
        for (const { repair } of looked.repairs) {
          out.change.modules += 1;
          out.change.removed += repair.remove.size;
          out.change.restored += repair.restore.length;
        }
        for (const { why } of looked.skipped) {
          out.skip.modules += 1;
          out.skip.why[why] = (out.skip.why[why] ?? 0) + 1;
        }
        if (looked.repairs.length > 0) out.change.layouts += 1;
        else out.skip.layouts += 1;
      } catch {
        out.unreadable += 1;
      } finally {
        doc.destroy();
        forgetSharedGeometry();
      }
    }
  }
}

const WHY: Record<SkipReason, string> = {
  listed_twice: 'a part is listed by two modules',
  not_shared: "not shared with the layout's owner",
  no_owner: 'the library module is gone or has no owner',
  no_version: "the version the layout has isn't kept or can't be read",
  whole_sets: 'the whole module is there more than once, every set as its owner has it',
  cannot_tell: "which parts are which can't be told",
};

/** The numbers in a few lines (no names, no ids). */
export function dryRunLines(r: DryRun): string[] {
  const why = Object.entries(r.skip.why).sort((a, b) => b[1] - a[1]);
  return [
    `Shared modules, extra copies of parts (dry run, nothing written): ${r.layouts} layouts looked at${r.unreadable ? `, ${r.unreadable} unreadable (left as they are)` : ''}`,
    `  would change: ${r.change.layouts} layouts, ${r.change.modules} modules, ${r.change.removed} extra copies taken out, ${r.change.restored} parts made as the owner's version has them`,
    `  would skip: ${r.skip.modules} modules (${r.skip.layouts} layouts where nothing changes)`,
    ...why.map(([k, n]) => `    ${n}: ${WHY[k as SkipReason]}`),
  ];
}
