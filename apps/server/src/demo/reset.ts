// Resetting the demo account: sign every visitor out, delete everything it
// owns, put the samples back, and tell anyone looking (the visitors'
// pages, which then say "The demo was reset. Start again?", and admins on
// the settings page) so their screens update without a reload.
//
// Only rows the demo account owns are touched. The timer in workers/
// index.ts and Admin › Settings › "Reset now" both run it through
// `runDemoReset`, so two resets never overlap.

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { count, eq } from 'drizzle-orm';
import { readBbm } from '@cld/bbm';
import { createDefaultLayoutDoc, encodeDoc, seedFromBbm } from '@cld/ydoc';
import { db, schema } from '../db/index.js';
import { env } from '../env.js';
import { docHub } from '../ws/docHub.js';
import { publish } from '../events/audience.js';
import { getPlatformSettings, PLATFORM_SETTINGS_ID } from '../auth/platformSettings.js';
import { DEMO_USER_ID, ensureDemoUser, signOutDemo } from './demoAccount.js';

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

async function deleteDemoThings(): Promise<string[]> {
  const layoutIds = (await db.select({ id: schema.layouts.id }).from(schema.layouts).where(eq(schema.layouts.ownerUserId, DEMO_USER_ID)).all()).map((r) => r.id);
  db.transaction((tx) => {
    // Transfers it started point at it without ON DELETE: go first.
    tx.delete(schema.layoutTransfers).where(eq(schema.layoutTransfers.initiatedBy, DEMO_USER_ID)).run();
    tx.delete(schema.moduleTransfers).where(eq(schema.moduleTransfers.initiatedBy, DEMO_USER_ID)).run();
    // Catalog submissions, then the things themselves. Module versions and
    // thumbnails, share links, invites, collaborators and saved views go
    // with their layout or module.
    tx.delete(schema.catalogItems).where(eq(schema.catalogItems.ownerUserId, DEMO_USER_ID)).run();
    tx.delete(schema.layouts).where(eq(schema.layouts.ownerUserId, DEMO_USER_ID)).run();
    tx.delete(schema.modules).where(eq(schema.modules.ownerUserId, DEMO_USER_ID)).run();
    tx.delete(schema.venueLibrary).where(eq(schema.venueLibrary.ownerUserId, DEMO_USER_ID)).run();
    tx.delete(schema.customParts).where(eq(schema.customParts.ownerUserId, DEMO_USER_ID)).run();
    tx.delete(schema.userPreferences).where(eq(schema.userPreferences.userId, DEMO_USER_ID)).run();
  });
  // Editors open on a deleted layout are told it's gone.
  await docHub.closeMany(layoutIds, 'demo_reset');
  const bgDir = join(dirname(env.dbPath), 'bgimages');
  for (const id of layoutIds) {
    for (const ext of ['png', 'jpg', 'gif', 'webp']) await unlink(join(bgDir, `${id}.${ext}`)).catch(() => undefined);
  }
  return layoutIds;
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
  await deleteDemoThings();
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
