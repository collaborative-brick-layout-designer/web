import { randomUUID } from 'node:crypto';
import { verify } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, resetDb, schema } from '../test/helpers.js';
import { env } from '../env.js';
import { ensureBootstrapAdmin } from './bootstrap.js';

const EMAIL = 'owner@club.example';
const PASSWORD = 'the operator password';

async function addUser(over: Partial<typeof schema.users.$inferInsert> = {}): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.users).values({
    id,
    email: EMAIL,
    displayName: '',
    avatarUrl: null,
    passwordHash: null,
    isDemoAccount: false,
    isGlobalAdmin: false,
    emailVerified: false,
    createdAt: new Date(),
    ...over,
  });
  return id;
}

const userRow = (email: string) => db.select().from(schema.users).where(eq(schema.users.email, email)).get();

describe('ensureBootstrapAdmin', () => {
  const saved = { email: env.bootstrapAdminEmail, password: env.bootstrapAdminPassword };
  beforeEach(() => {
    resetDb();
    env.bootstrapAdminEmail = EMAIL;
    env.bootstrapAdminPassword = PASSWORD;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    env.bootstrapAdminEmail = saved.email;
    env.bootstrapAdminPassword = saved.password;
    vi.restoreAllMocks();
  });

  it('creates the admin with the given password on a fresh start', async () => {
    await ensureBootstrapAdmin();
    const row = await userRow(EMAIL);
    expect(row?.isGlobalAdmin).toBe(true);
    expect(row?.emailVerified).toBe(true);
    expect(await verify(row!.passwordHash!, PASSWORD)).toBe(true);
    // A second start leaves the one account alone.
    await ensureBootstrapAdmin();
    expect(await db.select().from(schema.users)).toHaveLength(1);
  });

  it('does not promote an unverified account that already has the email', async () => {
    const id = await addUser({ passwordHash: 'someone else', emailVerified: false });
    await ensureBootstrapAdmin();
    const row = await userRow(EMAIL);
    expect(row?.id).toBe(id);
    expect(row?.isGlobalAdmin).toBe(false);
    expect(row?.passwordHash).toBe('someone else');
    const warned = vi.mocked(console.warn).mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('NOT made a site admin');
    expect(warned).toContain('Admin › Users');
  });

  it('does not promote a verified stranger account either', async () => {
    await addUser({ passwordHash: 'stranger', emailVerified: true });
    await ensureBootstrapAdmin();
    expect((await userRow(EMAIL))?.isGlobalAdmin).toBe(false);
    expect(await db.select().from(schema.users)).toHaveLength(1);
  });

  it('never makes the demo account an admin', async () => {
    await addUser({ isDemoAccount: true, emailVerified: true });
    await ensureBootstrapAdmin();
    expect((await userRow(EMAIL))?.isGlobalAdmin).toBe(false);
  });

  it('leaves an account that is already an admin as it is', async () => {
    await addUser({ isGlobalAdmin: true, emailVerified: true, passwordHash: 'kept' });
    await ensureBootstrapAdmin();
    const row = await userRow(EMAIL);
    expect(row?.isGlobalAdmin).toBe(true);
    expect(row?.passwordHash).toBe('kept');
  });

  it('does nothing without both env vars', async () => {
    env.bootstrapAdminPassword = null;
    await ensureBootstrapAdmin();
    expect(await db.select().from(schema.users)).toHaveLength(0);
  });
});
