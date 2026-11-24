// Layout version history: whole copies of a layout's document, kept so
// any of them can be looked at, put back or copied out as a new layout.
//
// When one is taken:
//   - while people edit: when the room saves itself (DocSession.flushSnapshot)
//     and the newest version is older than half an hour, if anything changed;
//   - just before a big change: an import into the layout or another layout
//     pasted into it (the apps ask first: POST …/versions), a restore (here),
//     and an edit that deletes many parts at once (ws/handler.ts);
//   - when someone asks ("Save a version now", with an optional name).
//
// How long they're kept (thinVersions, nightly): every one from the last
// day; then the newest of each day for 30 days and of each week for 26
// weeks; the ones taken before a big change for 30 days; named ones always
// (the newest 50). A version identical to the newest isn't kept twice.
//
// Putting one back never replaces the document: it is one ordinary change
// (syncDoc.ts) that makes the layout as it was, so people in the layout
// see it at once, and a version of the layout as it was just before is
// taken first, so a restore can be undone by restoring that one.

import { createHash, randomUUID } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import * as Y from 'yjs';
import { db, schema } from '../db/index.js';
import { summarize } from '../ops/unmergeLayouts.js';

export const VERSION_REASONS = ['auto', 'manual', 'before-import', 'before-merge', 'before-restore', 'before-bulk-delete'] as const;
export type VersionReason = (typeof VERSION_REASONS)[number];
/** Reasons the apps may ask for themselves. */
export const CLIENT_REASONS: readonly VersionReason[] = ['manual', 'before-import', 'before-merge'];

/** The least time between two versions taken while people edit. */
export const AUTO_EVERY_MS = 30 * 60 * 1000;
/** A version before a big change within this of an identical one isn't taken again. */
const SAME_WITHIN_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Before-a-big-change versions are kept this long. */
const BEFORE_KEEP_MS = 30 * DAY_MS;
const DAILY_KEEP_MS = 30 * DAY_MS;
const WEEKLY_KEEP_MS = 26 * 7 * DAY_MS;
const MANUAL_KEEP = 50;
/** Labels are short. */
export const LABEL_MAX = 80;

export interface VersionSummary {
  parts: number;
  sheets: number;
  modules: number;
  labels: number;
}

export interface Editor {
  id: string;
  name: string;
}

export function summaryOf(doc: Y.Doc): VersionSummary {
  const s = summarize(doc);
  return {
    parts: s.layers.reduce((n, l) => n + l.bricks, 0),
    sheets: s.layers.length,
    modules: s.modules,
    labels: s.labels,
  };
}

const hashOf = (state: Uint8Array) => createHash('sha256').update(state).digest('hex');

/** The newest version of a layout, without its document. */
async function newest(layoutId: string) {
  return db
    .select({ id: schema.layoutVersions.id, docHash: schema.layoutVersions.docHash, createdAt: schema.layoutVersions.createdAt, reason: schema.layoutVersions.reason })
    .from(schema.layoutVersions)
    .where(eq(schema.layoutVersions.layoutId, layoutId))
    .orderBy(desc(schema.layoutVersions.createdAt))
    .limit(1)
    .get();
}

export interface TakeOptions {
  layoutId: string;
  /** Y.encodeStateAsUpdate of the layout's document. */
  state: Uint8Array;
  reason: VersionReason;
  by?: string | null;
  label?: string | null;
  editors?: Editor[];
  now?: number;
}

/**
 * Keep a version. Returns its id, or the id of the newest one when that
 * one is the same document (and, for anything but a named version, recent
 * enough), so nothing identical is kept twice. Null when the layout is gone.
 */
export async function takeVersion({ layoutId, state, reason, by = null, label = null, editors = [], now = Date.now() }: TakeOptions): Promise<string | null> {
  const layout = await db.select({ title: schema.layouts.title }).from(schema.layouts).where(eq(schema.layouts.id, layoutId)).get();
  if (!layout) return null;
  const docHash = hashOf(state);
  const last = await newest(layoutId);
  if (last && last.docHash === docHash && !label) {
    if (reason === 'auto' || now - last.createdAt.getTime() < SAME_WITHIN_MS) return last.id;
  }
  const doc = new Y.Doc();
  let summary: VersionSummary;
  try {
    Y.applyUpdate(doc, state);
    summary = summaryOf(doc);
  } finally {
    doc.destroy();
  }
  const packed = deflateRawSync(state);
  const id = randomUUID();
  await db.insert(schema.layoutVersions).values({
    id,
    layoutId,
    reason,
    title: layout.title,
    label: label ? label.slice(0, LABEL_MAX) : null,
    docSnapshot: packed,
    docHash,
    summary: JSON.stringify(summary),
    editors: JSON.stringify(editors.slice(0, 20)),
    bytes: packed.length,
    createdBy: by,
    createdAt: new Date(now),
  });
  void tellViewers(layoutId);
  return id;
}

/** The history pages open on this layout update (a live 'layout' hint to its owner and collaborators). */
async function tellViewers(layoutId: string): Promise<void> {
  try {
    const { ownerOfResource, publish } = await import('../events/audience.js');
    const o = await ownerOfResource('layout', layoutId);
    const shared = await db.select({ userId: schema.layoutCollaborators.userId }).from(schema.layoutCollaborators).where(eq(schema.layoutCollaborators.layoutId, layoutId)).all();
    const users = shared.map((r) => r.userId);
    const hint = { kind: 'layout' as const, id: layoutId, action: 'update:versions' };
    await publish(o?.owner ? { ...hint, owner: o.owner } : hint, { users });
  } catch {
    /* hints never fail a change */
  }
}

/** While people edit: a version when the newest is old enough and the layout changed. */
export async function autoVersion(layoutId: string, state: Uint8Array, editors: Editor[], now = Date.now()): Promise<string | null> {
  const last = await newest(layoutId);
  if (last && now - last.createdAt.getTime() < AUTO_EVERY_MS) return null;
  return takeVersion({ layoutId, state, reason: 'auto', editors, by: editors.length === 1 ? editors[0]!.id : null, now });
}

/** A version's document (the Yjs state), or null. */
export async function versionState(layoutId: string, versionId: string): Promise<Uint8Array | null> {
  const row = await db
    .select({ doc: schema.layoutVersions.docSnapshot })
    .from(schema.layoutVersions)
    .where(and(eq(schema.layoutVersions.id, versionId), eq(schema.layoutVersions.layoutId, layoutId)))
    .get();
  if (!row) return null;
  return new Uint8Array(inflateRawSync(row.doc as Uint8Array));
}

export interface VersionListItem {
  id: string;
  reason: VersionReason;
  title: string;
  label: string | null;
  summary: VersionSummary;
  editors: Editor[];
  bytes: number;
  createdAt: number;
  createdBy: { id: string; name: string } | null;
}

const parseJson = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

/** A layout's versions, newest first. */
export async function listVersions(layoutId: string, limit = 200): Promise<VersionListItem[]> {
  const rows = await db
    .select({
      id: schema.layoutVersions.id,
      reason: schema.layoutVersions.reason,
      title: schema.layoutVersions.title,
      label: schema.layoutVersions.label,
      summary: schema.layoutVersions.summary,
      editors: schema.layoutVersions.editors,
      bytes: schema.layoutVersions.bytes,
      createdAt: schema.layoutVersions.createdAt,
      createdBy: schema.layoutVersions.createdBy,
      byName: schema.users.displayName,
    })
    .from(schema.layoutVersions)
    .leftJoin(schema.users, eq(schema.users.id, schema.layoutVersions.createdBy))
    .where(eq(schema.layoutVersions.layoutId, layoutId))
    .orderBy(desc(schema.layoutVersions.createdAt))
    .limit(limit)
    .all();
  return rows.map((r) => ({
    id: r.id,
    reason: (VERSION_REASONS as readonly string[]).includes(r.reason) ? (r.reason as VersionReason) : 'auto',
    title: r.title,
    label: r.label,
    summary: parseJson<VersionSummary>(r.summary, { parts: 0, sheets: 0, modules: 0, labels: 0 }),
    editors: parseJson<Editor[]>(r.editors, []),
    bytes: r.bytes,
    createdAt: r.createdAt.getTime(),
    createdBy: r.createdBy ? { id: r.createdBy, name: r.byName ?? '' } : null,
  }));
}

/** Which versions to let go, by the rules at the top. Pure, for tests. */
export function versionsToDrop(rows: readonly { id: string; reason: string; label: string | null; createdAt: number }[], now: number): string[] {
  const drop: string[] = [];
  const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
  const seenDay = new Set<number>();
  const seenWeek = new Set<number>();
  let named = 0;
  for (const r of sorted) {
    const age = now - r.createdAt;
    if (r.label) {
      named += 1;
      if (named > MANUAL_KEEP) drop.push(r.id);
      continue;
    }
    if (age <= DAY_MS) continue;
    if (r.reason !== 'auto' && r.reason !== 'manual') {
      if (age > BEFORE_KEEP_MS) drop.push(r.id);
      continue;
    }
    if (age <= DAILY_KEEP_MS) {
      const day = Math.floor(r.createdAt / DAY_MS);
      if (seenDay.has(day)) drop.push(r.id);
      else seenDay.add(day);
      continue;
    }
    if (age <= WEEKLY_KEEP_MS) {
      const week = Math.floor(r.createdAt / (7 * DAY_MS));
      if (seenWeek.has(week)) drop.push(r.id);
      else seenWeek.add(week);
      continue;
    }
    drop.push(r.id);
  }
  return drop;
}

/** Thin out every layout's versions (the nightly worker). Returns how many went. */
export async function thinVersions(now = Date.now()): Promise<number> {
  const layoutIds = (
    await db
      .selectDistinct({ id: schema.layoutVersions.layoutId })
      .from(schema.layoutVersions)
      .where(lt(schema.layoutVersions.createdAt, new Date(now - DAY_MS)))
      .all()
  ).map((r) => r.id);
  let gone = 0;
  for (const layoutId of layoutIds) {
    const rows = await db
      .select({ id: schema.layoutVersions.id, reason: schema.layoutVersions.reason, label: schema.layoutVersions.label, createdAt: schema.layoutVersions.createdAt })
      .from(schema.layoutVersions)
      .where(eq(schema.layoutVersions.layoutId, layoutId))
      .all();
    const drop = versionsToDrop(rows.map((r) => ({ ...r, createdAt: r.createdAt.getTime() })), now);
    for (let i = 0; i < drop.length; i += 200) {
      await db.delete(schema.layoutVersions).where(inArray(schema.layoutVersions.id, drop.slice(i, i + 200)));
    }
    gone += drop.length;
  }
  return gone;
}
