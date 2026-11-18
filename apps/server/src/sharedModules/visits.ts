// "Updated while you were away" (docs/shared-modules.md, phase 2): when
// each person last had a layout open (layout_visits), and the automatic
// shared-module updates (auto.ts) the layout got since then.
//
// A visit is stamped when someone leaves the layout's room and when the
// editor asks what changed (so the list is shown once). Someone who was
// in the room when an update came saw it there, and leaving stamps after
// it. The first visit ever lists nothing.

import { and, asc, eq, gt } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

/** The audit event an automatic update leaves (payload: AutoUpdatePayload). */
export const AUTO_UPDATE_EVENT = 'shared_module_auto_update' as const;

export interface AutoUpdatePayload {
  sharedModule: string;
  placedId: string;
  from: number | null;
  version: number;
  parts: number;
}

export interface AwayUpdate {
  placedId: string;
  moduleId: string;
  /** The version it had before the first update while away; null when not known. */
  from: number | null;
  /** The version the last one put in. */
  to: number;
  /** When the last one went in, in ms. */
  at: number;
}

/** Remember that `userId` had layout `layoutId` open until `at`. */
export async function stampVisit(layoutId: string, userId: string, at: Date = new Date()): Promise<void> {
  await db
    .insert(schema.layoutVisits)
    .values({ layoutId, userId, seenAt: at })
    .onConflictDoUpdate({ target: [schema.layoutVisits.layoutId, schema.layoutVisits.userId], set: { seenAt: at } })
    .run();
}

function payloadOf(text: string): AutoUpdatePayload | null {
  try {
    const p = JSON.parse(text) as Partial<AutoUpdatePayload>;
    if (typeof p.placedId !== 'string' || typeof p.sharedModule !== 'string' || typeof p.version !== 'number') return null;
    return { sharedModule: p.sharedModule, placedId: p.placedId, from: typeof p.from === 'number' ? p.from : null, version: p.version, parts: p.parts ?? 0 };
  } catch {
    return null;
  }
}

/**
 * The automatic updates layout `layoutId` got since `userId` last had it
 * open, one per placed module (oldest first), and the visit stamped now.
 */
export async function updatesWhileAway(layoutId: string, userId: string, now: Date = new Date()): Promise<AwayUpdate[]> {
  const visit = await db
    .select({ seenAt: schema.layoutVisits.seenAt })
    .from(schema.layoutVisits)
    .where(and(eq(schema.layoutVisits.layoutId, layoutId), eq(schema.layoutVisits.userId, userId)))
    .get();
  await stampVisit(layoutId, userId, now);
  if (!visit) return [];
  const events = await db
    .select({ payload: schema.auditEvents.payload, createdAt: schema.auditEvents.createdAt })
    .from(schema.auditEvents)
    .where(and(eq(schema.auditEvents.layoutId, layoutId), eq(schema.auditEvents.eventType, AUTO_UPDATE_EVENT), gt(schema.auditEvents.createdAt, visit.seenAt)))
    .orderBy(asc(schema.auditEvents.createdAt), asc(schema.auditEvents.id))
    .all();
  const out = new Map<string, AwayUpdate>();
  for (const e of events) {
    const p = payloadOf(e.payload);
    if (!p) continue;
    const had = out.get(p.placedId);
    out.set(p.placedId, {
      placedId: p.placedId,
      moduleId: p.sharedModule,
      from: had && had.moduleId === p.sharedModule ? had.from : p.from,
      to: p.version,
      at: e.createdAt.getTime(),
    });
  }
  return [...out.values()];
}
