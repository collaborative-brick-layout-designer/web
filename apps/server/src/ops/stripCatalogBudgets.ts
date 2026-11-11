// One-time fix: the budget is taken out of the published layout copies in
// the catalog that were stored with one.
//
// A layout's budget (how many of each part it may use, a Y.Map at
// `meta.budgetLimits`) is its owner's or its club's own business. For a
// short while a layout published to the catalog kept it in the stored copy
// (routes/catalogDocs.ts leaves it out since). It never reached anyone:
// every copy handed out is cleaned on the way (publishedDoc). This removes
// it from storage too.
//
// What it reads: catalog_item_versions rows of a layout item (every status,
// every version). What it writes: doc_snapshot of the rows whose document
// has `meta.budgetLimits`, and nothing else in them. Never a row of
// `layouts` (anyone's own layout, a copy someone added to theirs included),
// never a module, part or venue, and no row is deleted.
//
// A copy is rewritten the way the repair tools change a document: loaded,
// the key deleted in one Yjs transaction, and stored as the document's new
// state. Yjs then drops the deleted map's contents (the part numbers and
// limits); only the key's name stays, as a deleted entry. A copy without a
// budget keeps its bytes. One that can't be read is counted and left as it
// is.
//
// With `apply` it all happens in one database transaction, with whatever
// `inTransaction` writes (the audit event, the data_fixes row): stopped
// part-way, nothing was written and it runs again from the start. Running
// it again changes nothing.

import type Database from 'better-sqlite3';
import * as Y from 'yjs';
import { BUDGET_LIMITS_KEY } from '@cld/ydoc';

/** The fix's name: its data_fixes row, and the CBLD_DATA_FIX value that runs it. */
export const STRIP_BUDGETS_FIX_ID = 'strip-catalog-budgets';

/** The origin of the fix's Yjs transactions. */
export const STRIP_BUDGETS_ORIGIN = 'cld-strip-catalog-budgets';

/** The audit event the fix writes, once. */
export const DATA_FIX_EVENT = 'data_fix';

export type Stripped =
  /** No budget: the copy stays as it is. */
  | { state: 'none' }
  /** Not a document we can read (or one that waits for changes it doesn't have): left as it is. */
  | { state: 'unreadable' }
  /** The document's new state, without the budget. */
  | { state: 'stripped'; bytes: Uint8Array };

const hasBudget = (doc: Y.Doc) => doc.getMap('meta').has(BUDGET_LIMITS_KEY);

/** A document that read whole: nothing in it waits for changes it doesn't have. */
const whole = (doc: Y.Doc) => doc.store.pendingStructs === null && doc.store.pendingDs === null;

/** A stored copy without its budget (see the top of the file). */
export function withoutBudget(snapshot: Uint8Array): Stripped {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, snapshot);
    if (!whole(doc)) return { state: 'unreadable' };
    if (!hasBudget(doc)) return { state: 'none' };
    doc.transact(() => {
      doc.getMap('meta').delete(BUDGET_LIMITS_KEY);
    }, STRIP_BUDGETS_ORIGIN);
    const bytes = Y.encodeStateAsUpdate(doc);
    // Never store something that doesn't read back without the budget.
    const check = new Y.Doc();
    try {
      Y.applyUpdate(check, bytes);
      if (!whole(check) || hasBudget(check)) return { state: 'unreadable' };
    } finally {
      check.destroy();
    }
    return { state: 'stripped', bytes };
  } catch {
    return { state: 'unreadable' };
  } finally {
    doc.destroy();
  }
}

export interface StripSummary {
  apply: boolean;
  /** Stored layout copies looked at. */
  checked: number;
  /** Copies that held a budget (and, with `apply`, no longer do). */
  changed: number;
  /** Copies that couldn't be read (left as they are). */
  unreadable: number;
  /** Bytes the changed copies took before, and take now. */
  bytesBefore: number;
  bytesAfter: number;
  ms: number;
}

export interface StripOptions {
  /** Write the fix (false: only report what it would change). */
  apply: boolean;
  /** Rows read per query. */
  pageSize?: number;
  /** More to write in the fix's own transaction, once the copies are done (`apply` only). */
  inTransaction?: (summary: StripSummary) => void;
}

/**
 * Run the fix over every stored layout copy of the catalog (see the top of
 * the file). With `apply: false` nothing is written and the summary says
 * what would change.
 */
export function stripCatalogBudgets(sqlite: Database.Database, opts: StripOptions): StripSummary {
  const started = Date.now();
  const pageSize = opts.pageSize ?? 200;
  const summary: StripSummary = { apply: opts.apply, checked: 0, changed: 0, unreadable: 0, bytesBefore: 0, bytesAfter: 0, ms: 0 };
  const run = () => {
    // Ids a page at a time, documents one at a time: memory stays at about one document.
    const ids = sqlite.prepare(
      "select v.id from catalog_item_versions v join catalog_items i on i.id = v.item_id where i.kind = 'layout' and v.doc_snapshot is not null and v.id > ? order by v.id limit ?",
    );
    const row = sqlite.prepare('select doc_snapshot from catalog_item_versions where id = ?');
    const write = sqlite.prepare('update catalog_item_versions set doc_snapshot = ? where id = ?');
    let after = '';
    for (;;) {
      const page = ids.all(after, pageSize) as { id: string }[];
      if (page.length === 0) break;
      after = page[page.length - 1]!.id;
      for (const { id } of page) {
        const r = row.get(id) as { doc_snapshot: Buffer | null } | undefined;
        if (!r?.doc_snapshot) continue;
        summary.checked += 1;
        const out = withoutBudget(new Uint8Array(r.doc_snapshot));
        if (out.state === 'unreadable') summary.unreadable += 1;
        if (out.state !== 'stripped') continue;
        summary.changed += 1;
        summary.bytesBefore += r.doc_snapshot.length;
        summary.bytesAfter += out.bytes.length;
        if (opts.apply) write.run(Buffer.from(out.bytes), id);
      }
    }
    summary.ms = Date.now() - started;
    if (opts.apply) opts.inTransaction?.(summary);
  };
  if (opts.apply) sqlite.transaction(run).immediate();
  else run();
  return summary;
}

/** The one audit event of a run: the counts, no copy named. */
export function writeFixAudit(sqlite: Database.Database, summary: StripSummary, at = Date.now()): void {
  sqlite
    .prepare("insert into audit_events (resource_kind, resource_id, user_id, event_type, payload, created_at) values ('platform_settings', ?, null, ?, ?, ?)")
    .run(
      `data_fix:${STRIP_BUDGETS_FIX_ID}`,
      DATA_FIX_EVENT,
      JSON.stringify({ fix: STRIP_BUDGETS_FIX_ID, checked: summary.checked, changed: summary.changed, unreadable: summary.unreadable }),
      at,
    );
}

/** The summary in a line or two, for the log. */
export function stripSummaryLines(s: StripSummary): string[] {
  return [
    `${STRIP_BUDGETS_FIX_ID}${s.apply ? '' : ' (dry run, nothing written)'}: ${s.checked} published layout copies checked, ${s.changed} ${s.apply ? 'had their budget removed' : 'hold a budget'} (${s.bytesBefore} bytes${s.apply ? ` before, ${s.bytesAfter} now` : ''}), in ${s.ms} ms`,
    ...(s.unreadable ? [`  ${s.unreadable} couldn't be read and were left as they are`] : []),
  ];
}
