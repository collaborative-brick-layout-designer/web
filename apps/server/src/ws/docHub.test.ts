import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { db, resetDb, schema } from '../test/helpers.js';
import { docHub, DocSession } from './docHub.js';
import { bbmToDoc, encodeDoc } from '@cld/ydoc';
import { readBbm } from '@cld/bbm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/bbm/tests/fixtures',
);

async function makeUserAndLayout(): Promise<{ userId: string; layoutId: string; bbm: string }> {
  const userId = randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@example.com`,
    displayName: 'tester',
    avatarUrl: null,
    passwordHash: null,
    isDemoAccount: false,
    isGlobalAdmin: false,
    createdAt: new Date(),
  });
  const layoutId = randomUUID();
  const bbm = readFileSync(resolve(FIXTURES, 'tight-corner.bbm'), 'utf8');
  const map = readBbm(bbm).map;
  const seed = new Y.Doc();
  bbmToDoc(map, seed);
  const snapshot = encodeDoc(seed);
  const now = new Date();
  await db.insert(schema.layouts).values({
    id: layoutId,
    title: 'tight',
    ownerUserId: userId,
    ownerOrgId: null,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    docSnapshot: Buffer.from(snapshot),
    docVersion: 0,
    sidecarSnapshot: null,
  });
  return { userId, layoutId, bbm };
}

describe('DocSession.hydrate', () => {
  beforeEach(() => resetDb());

  it('reconstructs the doc from the persisted snapshot', async () => {
    const { layoutId } = await makeUserAndLayout();
    const session = new DocSession(layoutId);
    await session.hydrate();
    // The hydrated doc should have the meta/version we seeded.
    expect(session.doc.getMap('meta').get('version')).toBe(9);
  });

  it('replays unflushed updates after the snapshot', async () => {
    const { layoutId } = await makeUserAndLayout();
    // Build an update that mutates `meta.event` and stash it as an
    // unflushed row — same path the live WS handler takes.
    const session = new DocSession(layoutId);
    await session.hydrate();
    session.doc.getMap('meta').set('event', 'Updated event');
    const update = Y.encodeStateAsUpdate(session.doc);
    await db.insert(schema.layoutUpdates).values({
      layoutId,
      doc: 'main',
      updateBytes: Buffer.from(update),
      createdAt: new Date(),
    });

    // Hydrate a SECOND session — this is what happens after a server
    // restart. The replay must apply the unflushed update.
    const second = new DocSession(layoutId);
    await second.hydrate();
    expect(second.doc.getMap('meta').get('event')).toBe('Updated event');
  });
});

describe('DocSession.flushSnapshot', () => {
  beforeEach(() => resetDb());

  it('writes a fresh snapshot and truncates the update log', async () => {
    const { layoutId } = await makeUserAndLayout();
    const session = new DocSession(layoutId);
    await session.hydrate();

    // Two unflushed updates.
    for (const event of ['first', 'second']) {
      session.doc.getMap('meta').set('event', event);
      const u = Y.encodeStateAsUpdate(session.doc);
      await db.insert(schema.layoutUpdates).values({
        layoutId,
        doc: 'main',
        updateBytes: Buffer.from(u),
        createdAt: new Date(),
      });
    }

    await session.flushSnapshot();

    // The snapshot now reflects the latest doc.
    const layout = await db
      .select()
      .from(schema.layouts)
      .where(eq(schema.layouts.id, layoutId))
      .get();
    const reread = new Y.Doc();
    Y.applyUpdate(reread, new Uint8Array(layout!.docSnapshot as Uint8Array));
    expect(reread.getMap('meta').get('event')).toBe('second');

    // Update log is empty.
    const remaining = await db
      .select()
      .from(schema.layoutUpdates)
      .where(eq(schema.layoutUpdates.layoutId, layoutId));
    expect(remaining).toHaveLength(0);

    // docVersion bumped.
    expect(layout!.docVersion).toBeGreaterThan(0);
  });

  it('is idempotent if called concurrently', async () => {
    // The flushing flag should debounce two concurrent calls. We assert
    // both resolve without throwing — even though one becomes a no-op.
    const { layoutId } = await makeUserAndLayout();
    const session = new DocSession(layoutId);
    await session.hydrate();
    await Promise.all([session.flushSnapshot(), session.flushSnapshot()]);
    // Reaching here is the assertion: no concurrent-modification crash.
    expect(true).toBe(true);
  });
});

describe('docHub eviction', () => {
  beforeEach(() => {
    resetDb();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('evicts a session 60s after the last client detaches', async () => {
    const { layoutId } = await makeUserAndLayout();
    const fakeWs = {} as unknown;

    const session = await docHub.getOrCreate(layoutId);
    docHub.attach(session, fakeWs);
    await docHub.detach(session, fakeWs);

    // Eviction is timer-driven. Advance fake time past the threshold.
    await vi.advanceTimersByTimeAsync(60_000);

    // A new getOrCreate after eviction returns a FRESH session (not
    // the same instance).
    const second = await docHub.getOrCreate(layoutId);
    expect(second).not.toBe(session);
  });
});

describe('live edits and the layout\'s "updated" time', () => {
  beforeEach(() => resetDb());

  it('moves updatedAt with live edits, at most once a minute', async () => {
    const { layoutId } = await makeUserAndLayout();
    const old = new Date(Date.now() - 3_600_000);
    await db.update(schema.layouts).set({ updatedAt: old }).where(eq(schema.layouts.id, layoutId));
    const session = new DocSession(layoutId);
    const at = async () => (await db.select({ u: schema.layouts.updatedAt }).from(schema.layouts).where(eq(schema.layouts.id, layoutId)).get())!.u.getTime();
    const edit = () => {
      const d = new Y.Doc();
      d.getMap('m').set('k', Math.random());
      return Y.encodeStateAsUpdate(d);
    };
    await session.persistUpdate(edit());
    const first = await at();
    expect(first).toBeGreaterThan(old.getTime());
    // Within the minute: not again.
    await db.update(schema.layouts).set({ updatedAt: old }).where(eq(schema.layouts.id, layoutId));
    await session.persistUpdate(edit());
    expect(await at()).toBe(old.getTime());
    // A minute later: again.
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    try {
      await session.persistUpdate(edit());
    } finally {
      now.mockRestore();
    }
    expect(await at()).toBeGreaterThan(old.getTime());
  });
});
