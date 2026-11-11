// The mail (SMTP) password an admin saves is encrypted in the database,
// never sent back, and still reaches the mail server as typed. With a
// missing or different key the server keeps working: Admin › Settings says
// the password can't be read, no email is sent, and entering it again
// puts things right.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { existsSync, statSync, unlinkSync } from 'node:fs';

const created: { auth?: { user: string; pass: string } | undefined }[] = [];
const sendMail = vi.fn().mockResolvedValue(undefined);
vi.mock('nodemailer', () => {
  const createTransport = (opts: { auth?: { user: string; pass: string } }) => {
    created.push(opts);
    return { sendMail };
  };
  return { createTransport, default: { createTransport } };
});

import { db, loginAs, resetDb, schema } from '../../test/helpers.js';
import { sqlite } from '../../db/index.js';
import { attachUser } from '../../auth/cookie.js';
import { passwordRoutes } from '../auth/password.js';
import { sessionRoutes } from '../auth/session.js';
import { adminRoutes } from '../admin.js';
import { env } from '../../env.js';
import { getTransporter, invalidateTransporter } from '../../email/transporter.js';
import { sendInviteEmail } from '../../email/sendInvite.js';
import { encryptStoredMailPassword, forgetSecretKey, isEncrypted, MAIL_PASSWORD_UNREADABLE, readSecret, secretKeyPath } from '../../secrets/secretBox.js';

const SECRET = 'S3cret-mail-pass-9x';

interface SmtpView {
  host: string | null;
  passSet: boolean;
  passUnreadable: boolean;
  active: boolean;
  source: string | null;
}

let app: FastifyInstance;
let adminCookie: string;

async function buildApp(): Promise<FastifyInstance> {
  const a = Fastify();
  await a.register(cookie);
  a.addHook('preHandler', attachUser);
  await a.register(passwordRoutes);
  await a.register(sessionRoutes);
  await a.register(adminRoutes);
  return a;
}

async function adminLogin(): Promise<string> {
  const { cookie: c } = await loginAs(app, 'admin@example.com');
  await db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.email, 'admin@example.com'));
  return c;
}

const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: { cookie: adminCookie }, payload });
const smtpView = async () => {
  const res = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: { cookie: adminCookie } });
  return { body: res.body, smtp: (res.json() as { smtp: SmtpView }).smtp };
};
const storedPass = () => (sqlite.prepare(`SELECT smtp_pass AS p FROM platform_settings WHERE id = 'singleton'`).get() as { p: string | null }).p;

beforeEach(async () => {
  resetDb();
  env.secretKey = '';
  forgetSecretKey();
  invalidateTransporter();
  created.length = 0;
  sendMail.mockClear();
  app = await buildApp();
  adminCookie = await adminLogin();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  env.secretKey = '';
  forgetSecretKey();
  await app.close();
});

describe('the saved mail password', () => {
  it('is encrypted in the database, never sent back, and reaches the mail server as typed', async () => {
    expect((await patch({ smtpHost: 'smtp.example.com', smtpUser: 'mailer', smtpFrom: 'noreply@example.com', smtpPass: SECRET })).statusCode).toBe(200);
    const at = storedPass()!;
    expect(isEncrypted(at)).toBe(true);
    expect(at).not.toContain(SECRET);
    // The key file is beside the database, for its owner only.
    const keyFile = secretKeyPath(env.dbPath);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);

    const { body, smtp } = await smtpView();
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(at);
    expect(smtp).toMatchObject({ passSet: true, passUnreadable: false, active: true, source: 'database' });

    expect(await sendInviteEmail({ to: 'someone@example.com', inviteUrl: 'https://x.example/invite/1', inviterName: 'Ann' })).toBe(true);
    expect(created.at(-1)!.auth).toEqual({ user: 'mailer', pass: SECRET });
    expect(sendMail).toHaveBeenCalledTimes(1);

    // Saving something else leaves it alone; "" clears it.
    await patch({ smtpFrom: 'other@example.com' });
    expect(storedPass()).toBe(at);
    await patch({ smtpPass: '' });
    expect(storedPass()).toBeNull();
    expect((await smtpView()).smtp).toMatchObject({ passSet: false, passUnreadable: false, active: true });
  });

  it('refuses a password that isn’t text or is far too long', async () => {
    expect((await patch({ smtpHost: 'smtp.example.com', smtpPass: 12345 })).json()).toEqual({ error: 'invalid_smtp_pass' });
    expect((await patch({ smtpHost: 'smtp.example.com', smtpPass: 'x'.repeat(1025) })).statusCode).toBe(400);
    expect(storedPass()).toBeNull();
  });

  it('another key: the server answers, Admin says to enter it again, no email goes out, and entering it again works', async () => {
    await patch({ smtpHost: 'smtp.example.com', smtpUser: 'mailer', smtpFrom: 'noreply@example.com', smtpPass: SECRET });
    // The operator sets (or changes) CBLD_SECRET_KEY: the file's key no longer applies.
    env.secretKey = 'a-different-key-0123456789abcdef';
    forgetSecretKey();
    invalidateTransporter();

    const { body, smtp } = await smtpView();
    expect(smtp).toMatchObject({ passSet: true, passUnreadable: true, active: false, source: 'database' });
    expect(body).not.toContain(SECRET);

    // Sending fails softly, like a site with no mail server, and the log says why.
    expect(await getTransporter()).toBeNull();
    expect(await sendInviteEmail({ to: 'someone@example.com', inviteUrl: 'https://x.example/invite/1', inviterName: 'Ann' })).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
    const said = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(said.filter((l) => l.includes(MAIL_PASSWORD_UNREADABLE))).toHaveLength(1); // once, not per email

    // Entered again: stored under the key in use, and mail goes out.
    expect((await patch({ smtpPass: 'entered-again' })).statusCode).toBe(200);
    expect((await smtpView()).smtp).toMatchObject({ passSet: true, passUnreadable: false, active: true });
    expect(await sendInviteEmail({ to: 'someone@example.com', inviteUrl: 'https://x.example/invite/1', inviterName: 'Ann' })).toBe(true);
    expect(created.at(-1)!.auth).toEqual({ user: 'mailer', pass: 'entered-again' });
  });

  it('a deleted key file: a new one is made, and the password is asked for again', async () => {
    await patch({ smtpHost: 'smtp.example.com', smtpUser: 'mailer', smtpPass: SECRET });
    unlinkSync(secretKeyPath(env.dbPath));
    forgetSecretKey();
    invalidateTransporter();
    expect((await smtpView()).smtp).toMatchObject({ passSet: true, passUnreadable: true, active: false });
    expect(existsSync(secretKeyPath(env.dbPath))).toBe(true);
    expect(statSync(secretKeyPath(env.dbPath)).mode & 0o777).toBe(0o600);
  });

  it('a too-short CBLD_SECRET_KEY: nothing can be stored, and the save says so instead of keeping it in the clear', async () => {
    env.secretKey = 'short';
    forgetSecretKey();
    const res = await patch({ smtpHost: 'smtp.example.com', smtpPass: SECRET });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'secret_key_unavailable' });
    expect(storedPass()).toBeNull();
  });

  it('one saved before encryption still works, and the start-up step encrypts it once', async () => {
    await patch({ smtpHost: 'smtp.example.com', smtpUser: 'mailer' });
    sqlite.prepare(`UPDATE platform_settings SET smtp_pass = ? WHERE id = 'singleton'`).run('from-an-older-version');
    expect((await smtpView()).smtp).toMatchObject({ passSet: true, passUnreadable: false, active: true });
    const lines: string[] = [];
    expect(encryptStoredMailPassword(sqlite, (l) => lines.push(l))).toBe('encrypted');
    expect(lines).toHaveLength(1);
    expect(isEncrypted(storedPass()!)).toBe(true);
    expect(readSecret(storedPass())).toEqual({ state: 'ok', value: 'from-an-older-version' });
    expect(encryptStoredMailPassword(sqlite, (l) => lines.push(l))).toBe('nothing');
    expect(lines).toHaveLength(1);
    invalidateTransporter();
    await sendInviteEmail({ to: 'someone@example.com', inviteUrl: 'https://x.example/invite/1', inviterName: 'Ann' });
    expect(created.at(-1)!.auth).toEqual({ user: 'mailer', pass: 'from-an-older-version' });
  });
});
