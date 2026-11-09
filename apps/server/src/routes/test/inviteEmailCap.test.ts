// The daily cap on invite and hand-over emails (email/inviteEmailCap.ts):
// every route that emails an invite counts toward one per-person cap,
// brand-new accounts get the lower one, and past the cap the invite is
// still made, with a note telling the sender to copy the link.

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const sendMail = vi.fn().mockResolvedValue(undefined);
vi.mock('../../email/transporter.js', () => ({
  getTransporter: vi.fn(async () => ({
    transporter: { sendMail },
    config: { host: 'smtp.example.com', port: 587, user: null, pass: null, from: 'noreply@example.com', source: 'env' },
  })),
}));

const { attachUser } = await import('../../auth/cookie.js');
const { registerApiRoutes } = await import('../all.js');
const { closeAll } = await import('../../events/hub.js');
const { invalidateLimitCaches, userLimits } = await import('../../limits/limits.js');
const { usage } = await import('../../metrics/usage.js');
const { env } = await import('../../env.js');
const { db, loginAs, resetDb, schema } = await import('../../test/helpers.js');

type Who = { cookie: string; id: string };
/** Invite and hand-over emails sent (not other notices, e.g. a new club's). */
const invitesSent = () => sendMail.mock.calls.filter(([m]) => /invited you|hand a layout over/.test((m as { subject: string }).subject)).length;
type Mail = { emailDelivered: boolean; emailCapped?: boolean; emailNote?: string };

const FAKE_GIF = Buffer.from('GIF89a    \xff\xff\xff   !\xf9    ,       D ;', 'binary').toString('base64');
const SAMPLE_XML = Buffer.from('<?xml version="1.0"?><part/>').toString('base64');
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify({ bodyLimit: 10 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(fastifyMultipart);
  app.addHook('preHandler', attachUser);
  await registerApiRoutes(app);
  await app.ready();
});
afterAll(async () => {
  closeAll();
  await app.close();
});
beforeEach(() => {
  resetDb();
  usage.reset();
  invalidateLimitCaches();
  sendMail.mockReset();
  sendMail.mockResolvedValue(undefined);
  env.limitsEnforceForced = null;
});

const call = (who: Who, method: 'POST' | 'GET', url: string, payload?: object) =>
  app.inject({ method, url, headers: { cookie: who.cookie }, ...(payload ? { payload } : {}) });

function age(who: Who, days: number) {
  db.update(schema.users).set({ createdAt: new Date(Date.now() - days * DAY) }).where(eq(schema.users.id, who.id)).run();
}
function capAt(who: Who, n: number) {
  db.insert(schema.limitOverrides).values({ subjectKind: 'user', subjectId: who.id, limits: JSON.stringify({ inviteEmailsPerDay: n }), suspended: false, updatedAt: new Date() }).run();
  invalidateLimitCaches();
}

async function newLayout(who: Who) {
  const r = await call(who, 'POST', '/api/layouts', { title: 'Harbor' });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as { id: string }).id;
}

let seq = 0;
/** One call to each of the six routes that email an invite. */
async function everyRoute(who: Who): Promise<{ route: string; status: number; body: Mail & Record<string, unknown> }[]> {
  const layoutId = await newLayout(who);
  const mod = await call(who, 'POST', '/api/modules', { title: 'Turntable' });
  expect(mod.statusCode, mod.body).toBe(201);
  const part = await call(who, 'POST', '/api/custom-parts', { partNumber: `CAP${++seq}`, displayName: 'Tower', xmlBase64: SAMPLE_XML, spriteBase64: FAKE_GIF, spriteMime: 'image/gif' });
  expect(part.statusCode, part.body).toBe(201);
  const org = await call(who, 'POST', '/api/orgs', { name: `Cap Club ${seq}` });
  expect(org.statusCode, org.body).toBe(201);
  const slug = (org.json() as { slug: string }).slug;
  const out: { route: string; status: number; body: Mail & Record<string, unknown> }[] = [];
  const add = async (route: string, p: Promise<{ statusCode: number; json: () => unknown }>) => {
    const r = await p;
    out.push({ route, status: r.statusCode, body: r.json() as Mail & Record<string, unknown> });
  };
  const n = ++seq;
  await add('layout', call(who, 'POST', `/api/layouts/${layoutId}/invites`, { email: `l${n}@example.com`, role: 'editor' }));
  await add('module', call(who, 'POST', `/api/modules/${(mod.json() as { id: string }).id}/invites`, { email: `m${n}@example.com`, role: 'editor' }));
  await add('part', call(who, 'POST', `/api/custom-parts/${(part.json() as { id: string }).id}/invites`, { email: `p${n}@example.com`, role: 'editor' }));
  await add('club', call(who, 'POST', `/api/orgs/${slug}/invites`, { email: `c${n}@example.com`, role: 'member' }));
  const inviteId = String(out.at(-1)!.body.id);
  await add('club resend', call(who, 'POST', `/api/orgs/${slug}/invites/${inviteId}/resend`, {}));
  await add('hand-over', call(who, 'POST', `/api/layouts/${layoutId}/transfer`, { recipientEmail: `t${n}@example.com` }));
  return out;
}

describe('invite and hand-over emails a day', () => {
  it('counts all six routes against one cap; past it the invite is still made, with the link and a note', async () => {
    const ada = await loginAs(app, 'ada@example.com');
    age(ada, 30);
    capAt(ada, 6);
    const first = await everyRoute(ada);
    for (const r of first) {
      expect(r.status, r.route).toBe(200);
      expect(r.body.emailDelivered, r.route).toBe(true);
      expect(r.body.emailNote, r.route).toBeUndefined();
    }
    expect(invitesSent()).toBe(6);

    const second = await everyRoute(ada);
    for (const r of second) {
      expect(r.status, r.route).toBe(200);
      expect(r.body, r.route).toMatchObject({ emailDelivered: false, emailCapped: true });
      expect(r.body.emailNote, r.route).toBe('You’ve sent 6 invite emails today, the most for one day, so this one wasn’t emailed. Your invite is ready: copy the link and send it yourself.');
      // The link is there to copy.
      expect(String(r.body.inviteUrl ?? r.body.transferUrl), r.route).toMatch(/^http.*\/(invite|module-invite|part-invite|org-invite|transfer)\//);
    }
    expect(invitesSent()).toBe(6);
    // The invites were made all the same.
    expect(db.select().from(schema.layoutInvites).all()).toHaveLength(2);
    expect(db.select().from(schema.moduleInvites).all()).toHaveLength(2);
    expect(db.select().from(schema.customPartInvites).all()).toHaveLength(2);
    expect(db.select().from(schema.orgInvites).all()).toHaveLength(2);
    expect(db.select().from(schema.layoutTransfers).all()).toHaveLength(2);
  });

  it('gives brand-new accounts the lower cap, and older ones the full one', async () => {
    const fresh = await loginAs(app, 'fresh@example.com');
    const user = db.select().from(schema.users).where(eq(schema.users.id, fresh.id)).get()!;
    expect((await userLimits(user)).inviteEmailsPerDay).toMatchObject({ value: 10, source: 'smart' });
    const layoutId = await newLayout(fresh);
    const invite = (i: number) => call(fresh, 'POST', `/api/layouts/${layoutId}/invites`, { email: `x${i}@example.com`, role: 'viewer' });
    for (let i = 0; i < 10; i++) expect(((await invite(i)).json() as Mail).emailDelivered).toBe(true);
    const capped = (await invite(10)).json() as Mail;
    expect(capped).toMatchObject({ emailDelivered: false, emailCapped: true });
    expect(capped.emailNote).toMatch(/^You’ve sent 10 invite emails today/);

    age(fresh, 8);
    const older = db.select().from(schema.users).where(eq(schema.users.id, fresh.id)).get()!;
    expect((await userLimits(older)).inviteEmailsPerDay).toMatchObject({ value: 50, source: 'default' });
    expect(((await invite(11)).json() as Mail).emailDelivered).toBe(true);
  });

  it('counts but never caps while usage limits are off', async () => {
    const bo = await loginAs(app, 'bo@example.com');
    capAt(bo, 1);
    env.limitsEnforceForced = 'off';
    const layoutId = await newLayout(bo);
    for (let i = 0; i < 3; i++) {
      const r = (await call(bo, 'POST', `/api/layouts/${layoutId}/invites`, { email: `y${i}@example.com`, role: 'viewer' })).json() as Mail;
      expect(r.emailDelivered).toBe(true);
    }
    expect(usage.today('user', bo.id, 'invite_emails')).toBe(3);
  });

  it('does not count an email that failed to send', async () => {
    const cy = await loginAs(app, 'cy@example.com');
    capAt(cy, 1);
    sendMail.mockRejectedValueOnce(new Error('smtp down'));
    const layoutId = await newLayout(cy);
    const failed = (await call(cy, 'POST', `/api/layouts/${layoutId}/invites`, { email: 'z1@example.com', role: 'viewer' })).json() as Mail;
    expect(failed).toEqual(expect.objectContaining({ emailDelivered: false }));
    expect(failed.emailCapped).toBeUndefined();
    const ok = (await call(cy, 'POST', `/api/layouts/${layoutId}/invites`, { email: 'z2@example.com', role: 'viewer' })).json() as Mail;
    expect(ok.emailDelivered).toBe(true);
  });

  it('shows today’s count on the admin’s page for that person', async () => {
    const admin = await loginAs(app, 'root@example.com');
    db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, admin.id)).run();
    const dee = await loginAs(app, 'dee@example.com');
    const layoutId = await newLayout(dee);
    await call(dee, 'POST', `/api/layouts/${layoutId}/invites`, { email: 'w@example.com', role: 'viewer' });
    const page = (await call(admin, 'GET', `/api/admin/users/${dee.id}/usage`)).json() as { limits: { key: string; used: number | null; value: number; unit: string }[] };
    expect(page.limits.find((l) => l.key === 'inviteEmailsPerDay')).toMatchObject({ used: 1, value: 10, unit: 'per_day' });
  });
});
