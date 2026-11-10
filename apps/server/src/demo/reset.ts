// Resetting the demo account: sign every visitor out, delete everything it
// owns, put the samples back, and tell anyone looking (the visitors'
// pages, which then say "The demo was reset. Start again?", and admins on
// the settings page) so their screens update without a reload.
//
// Only rows the demo account owns are touched. The timer in workers/
// index.ts and Admin › Settings › "Reset now" both run it through
// `runDemoReset`, so two resets never overlap.

import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, count, eq, gt, ne } from 'drizzle-orm';
import { readBbm } from '@cld/bbm';
import { createDefaultLayoutDoc, encodeDoc, seedFromBbm } from '@cld/ydoc';
import { db, schema } from '../db/index.js';
import { env } from '../env.js';
import { docHub } from '../ws/docHub.js';
import { publish } from '../events/audience.js';
import { getPlatformSettings, PLATFORM_SETTINGS_ID } from '../auth/platformSettings.js';
import { DEMO_USER_ID, ensureDemoUser, signOutDemo } from './demoAccount.js';
import { invalidateAllSessions } from '../auth/session.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';

/**
 * The samples are the repo's own test fixtures (packages/bbm/tests/
 * fixtures; the Dockerfile copies these three into the image). The path
 * is the same from src/demo and dist/demo.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures');
export const DEMO_SAMPLES = {
  layout: { file: 'tight-corner.bbm', title: 'Sample layout' },
  module: { file: 'oracle/flex-a.bbm', title: 'Sample module' },
  /** A hall, named as one would be (an install without the file gets an empty one by this name). */
  venue: { file: 'grand-lobby.bld-venue', name: 'Community Hall' },
} as const;

/** The namespace the samples' ids are made in (UUIDv5, RFC 4122). Never change it: links to the samples use these ids. */
const DEMO_NAMESPACE = '6f0c2d1e-9a4b-5c3d-8e7f-0a1b2c3d4e5f';

/** A UUIDv5 of `name` in `namespace`: the same every time. */
export function uuidV5(name: string, namespace = DEMO_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Each sample's id, the same after every reset (UUIDv5 of the demo account
 * and the sample's key), so a link, share or bookmark to "Sample layout"
 * keeps working from one day to the next.
 */
export const DEMO_SAMPLE_IDS = {
  layout: uuidV5('demo-account:layout'),
  module: uuidV5('demo-account:module'),
  venue: uuidV5('demo-account:venue'),
} as const;

/** The sample venue's data from its file (its own name, else "Community Hall"); an empty hall when it's missing or unreadable. */
export function sampleVenue(text: string | null): Record<string, unknown> & { name: string } {
  const empty = { name: DEMO_SAMPLES.venue.name, edges: [] };
  if (!text) return empty;
  try {
    const { schema: _format, ...data } = JSON.parse(text) as Record<string, unknown>;
    const name = typeof data.name === 'string' && data.name.trim() ? data.name : DEMO_SAMPLES.venue.name;
    return { ...data, name };
  } catch (err) {
    console.warn('[demo] could not read the sample venue', err);
    return empty;
  }
}

/** A sample file's text, or null (logged) when this install doesn't have it. */
function sample(file: string): string | null {
  try {
    return readFileSync(join(FIXTURES, file), 'utf8');
  } catch (err) {
    console.warn(`[demo] sample ${file} is missing; using an empty one`, err);
    return null;
  }
}

function docFromBbm(text: string | null): Uint8Array {
  if (text) {
    try {
      return encodeDoc(seedFromBbm(readBbm(text).map));
    } catch (err) {
      console.warn('[demo] could not read a sample layout; using an empty one', err);
    }
  }
  return encodeDoc(createDefaultLayoutDoc());
}

/** How many layouts, modules, venues and custom parts the demo account has. */
export async function demoItemCount(): Promise<number> {
  let n = 0;
  for (const t of [schema.layouts, schema.modules, schema.venueLibrary, schema.customParts]) {
    n += (await db.select({ n: count() }).from(t).where(eq(t.ownerUserId, DEMO_USER_ID)).get())?.n ?? 0;
  }
  return n;
}

/** What one demo account's delete took, for its audit event. */
export interface DemoSpaceCounts {
  layouts: number;
  modules: number;
  venues: number;
  parts: number;
}

/**
 * Delete everything `userId` (a demo account) owns: layouts and their
 * history, modules and their versions, venues, custom parts and any
 * background pictures. Editors open on its layouts are told "The demo
 * was reset". The one delete routine for the reset and the clean-up.
 */
async function deleteDemoThings(userId: string): Promise<DemoSpaceCounts> {
  const layoutIds = (await db.select({ id: schema.layouts.id }).from(schema.layouts).where(eq(schema.layouts.ownerUserId, userId)).all()).map((r) => r.id);
  const counts: DemoSpaceCounts = { layouts: layoutIds.length, modules: 0, venues: 0, parts: 0 };
  db.transaction((tx) => {
    // Transfers it started point at it without ON DELETE: go first.
    tx.delete(schema.layoutTransfers).where(eq(schema.layoutTransfers.initiatedBy, userId)).run();
    tx.delete(schema.moduleTransfers).where(eq(schema.moduleTransfers.initiatedBy, userId)).run();
    // Catalog submissions, then the things themselves. Module versions and
    // thumbnails, share links, invites, collaborators and saved views go
    // with their layout or module.
    tx.delete(schema.catalogItems).where(eq(schema.catalogItems.ownerUserId, userId)).run();
    tx.delete(schema.layouts).where(eq(schema.layouts.ownerUserId, userId)).run();
    counts.modules = tx.delete(schema.modules).where(eq(schema.modules.ownerUserId, userId)).run().changes;
    counts.venues = tx.delete(schema.venueLibrary).where(eq(schema.venueLibrary.ownerUserId, userId)).run().changes;
    counts.parts = tx.delete(schema.customParts).where(eq(schema.customParts.ownerUserId, userId)).run().changes;
    tx.delete(schema.userPreferences).where(eq(schema.userPreferences.userId, userId)).run();
  });
  // Editors open on a deleted layout are told it's gone.
  await docHub.closeMany(layoutIds, 'demo_reset');
  const bgDir = join(dirname(env.dbPath), 'bgimages');
  for (const id of layoutIds) {
    for (const ext of ['png', 'jpg', 'gif', 'webp']) await unlink(join(bgDir, `${id}.${ext}`)).catch(() => undefined);
  }
  return counts;
}

/**
 * Delete a visitor's demo space: signed out, everything it owns, then the
 * account itself, with one audit event (counts, never one per layout).
 */
export async function deleteDemoSpace(userId: string, why: 'expired' | 'reset' | 'demo_off'): Promise<boolean> {
  if (userId === DEMO_USER_ID) return false;
  const user = await db.select({ id: schema.users.id, isDemo: schema.users.isDemoAccount }).from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!user?.isDemo) return false;
  await invalidateAllSessions(userId, why === 'demo_off' ? 'demo_off' : 'demo_reset');
  const counts = await deleteDemoThings(userId);
  await db.delete(schema.apiTokens).where(eq(schema.apiTokens.userId, userId));
  await db.delete(schema.users).where(eq(schema.users.id, userId));
  await writeAuditEvent({ resourceKind: 'user', resourceId: userId, userId: null, eventType: 'demo_space_deleted', payload: { why, ...counts } });
  return true;
}

/** Admin › Settings › Demo account's count of spaces in use changed. */
async function spacesChanged(): Promise<void> {
  await publish({ kind: 'admin', action: 'demo-space', id: 'deleted' }, { ownerless: true });
}

/** Every visitor's demo space (not the template). */
async function demoSpaceIds(): Promise<string[]> {
  return (await db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.isDemoAccount, true), ne(schema.users.id, DEMO_USER_ID))).all()).map((r) => r.id);
}

/** Delete every visitor's demo space (the demo switched off). */
export async function deleteAllDemoSpaces(why: 'reset' | 'demo_off'): Promise<number> {
  let n = 0;
  for (const id of await demoSpaceIds()) n += Number(await deleteDemoSpace(id, why));
  if (n > 0) await spacesChanged();
  return n;
}

/**
 * The clean-up: delete every demo space whose time is up, by the clock
 * (its demo_expires_at, or its sign-ins all over), even when its visitor
 * just closed the tab. Runs at start-up and on the demo timer.
 */
export async function sweepDemoSpaces(now = new Date()): Promise<number> {
  const live = new Set(
    (await db.select({ u: schema.sessions.userId }).from(schema.sessions).where(gt(schema.sessions.expiresAt, now)).all()).map((r) => r.u),
  );
  const spaces = await db
    .select({ id: schema.users.id, expiresAt: schema.users.demoExpiresAt, createdAt: schema.users.createdAt })
    .from(schema.users)
    .where(and(eq(schema.users.isDemoAccount, true), ne(schema.users.id, DEMO_USER_ID)))
    .all();
  let n = 0;
  for (const sp of spaces) {
    const timeUp = !sp.expiresAt || sp.expiresAt.getTime() <= now.getTime();
    // Its sign-ins all over (a minute's grace: Try the demo makes the space, then its sign-in).
    const signedOut = !live.has(sp.id) && now.getTime() - sp.createdAt.getTime() > 60_000;
    if (timeUp || signedOut) n += Number(await deleteDemoSpace(sp.id, 'expired'));
  }
  if (n > 0) await spacesChanged();
  return n;
}

/** Put a private copy of the samples into a visitor's demo space (new ids; each remembers its sample). */
export async function copySamplesTo(userId: string, now = new Date()): Promise<void> {
  const layout = await db.select().from(schema.layouts).where(eq(schema.layouts.id, DEMO_SAMPLE_IDS.layout)).get();
  const module = await db.select().from(schema.modules).where(eq(schema.modules.id, DEMO_SAMPLE_IDS.module)).get();
  const venue = await db.select().from(schema.venueLibrary).where(eq(schema.venueLibrary.id, DEMO_SAMPLE_IDS.venue)).get();
  const base = { ownerUserId: userId, ownerOrgId: null, createdBy: userId, createdAt: now, updatedAt: now, docVersion: 0, sidecarSnapshot: null };
  db.transaction((tx) => {
    if (layout) tx.insert(schema.layouts).values({ ...base, id: randomUUID(), title: layout.title, docSnapshot: layout.docSnapshot, copiedFromId: layout.id }).run();
    if (module) tx.insert(schema.modules).values({ ...base, id: randomUUID(), title: module.title, docSnapshot: module.docSnapshot, copiedFromId: module.id }).run();
    if (venue) tx.insert(schema.venueLibrary).values({ id: randomUUID(), ownerUserId: userId, ownerOrgId: null, name: venue.name, data: venue.data, createdBy: userId, copiedFromId: venue.id, createdAt: now }).run();
  });
}

async function seedSamples(now: Date): Promise<void> {
  const layoutDoc = docFromBbm(sample(DEMO_SAMPLES.layout.file));
  const moduleDoc = docFromBbm(sample(DEMO_SAMPLES.module.file));
  const venue = sampleVenue(sample(DEMO_SAMPLES.venue.file));
  const base = { ownerUserId: DEMO_USER_ID, ownerOrgId: null, createdBy: DEMO_USER_ID, createdAt: now, updatedAt: now, docVersion: 0, sidecarSnapshot: null };
  db.transaction((tx) => {
    // Under the same ids as yesterday's (deleteDemoThings took the old rows,
    // with their live updates, versions, collaborators and share links).
    tx.insert(schema.layouts).values({ ...base, id: DEMO_SAMPLE_IDS.layout, title: DEMO_SAMPLES.layout.title, docSnapshot: Buffer.from(layoutDoc) }).run();
    tx.insert(schema.modules).values({ ...base, id: DEMO_SAMPLE_IDS.module, title: DEMO_SAMPLES.module.title, docSnapshot: Buffer.from(moduleDoc) }).run();
    tx.insert(schema.venueLibrary)
      .values({ id: DEMO_SAMPLE_IDS.venue, ownerUserId: DEMO_USER_ID, ownerOrgId: null, name: String(venue.name), data: JSON.stringify(venue), createdBy: DEMO_USER_ID, createdAt: now })
      .run();
  });
}

/**
 * Wipe the demo account's things and put the samples back. Makes the
 * account first if it isn't there (an admin may have deleted it).
 */
export async function resetDemoAccount(now = new Date()): Promise<{ lastResetAt: number; items: number }> {
  await getPlatformSettings();
  await ensureDemoUser();
  // Everyone in the demo now is signed out first (their open layouts close
  // with 'demo_reset'), so nobody edits what is being wiped.
  await signOutDemo('demo_reset');
  // Every visitor's space goes (their sign-ins end at the reset), then the
  // template's samples are put back under their own ids.
  await deleteAllDemoSpaces('reset');
  await deleteDemoThings(DEMO_USER_ID);
  await seedSamples(now);
  await db.update(schema.platformSettings).set({ demoLastResetAt: now }).where(eq(schema.platformSettings.id, PLATFORM_SETTINGS_ID));
  const owner = { kind: 'user', id: DEMO_USER_ID } as const;
  for (const kind of ['layout', 'module', 'venue', 'custom-part'] as const) await publish({ kind, owner, action: 'demo-reset' });
  // The banner's "next reset in…" (the demo account) and the admin page.
  await publish({ kind: 'me', owner, action: 'demo-reset' });
  await publish({ kind: 'admin', action: 'demo-reset' }, { ownerless: true });
  return { lastResetAt: now.getTime(), items: await demoItemCount() };
}

let running: Promise<{ lastResetAt: number; items: number }> | null = null;

/** The reset running now, if any (Try the demo waits for it). */
export function demoResetRunning(): Promise<unknown> | null {
  return running;
}

/** Run a reset, or join the one already running. */
export function runDemoReset(now?: Date): Promise<{ lastResetAt: number; items: number }> {
  running ??= resetDemoAccount(now).finally(() => {
    running = null;
  });
  return running;
}
