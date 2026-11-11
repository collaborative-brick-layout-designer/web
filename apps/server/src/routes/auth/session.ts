import type { FastifyInstance } from 'fastify';
import { and, eq, gte } from 'drizzle-orm';
import { invalidateOtherSessions, invalidateSession, publicSessionId, SESSION_COOKIE, sessionIdForToken } from '../../auth/session.js';
import { notifyCredentialRevoked } from '../../auth/revocation.js';
import { clearSessionCookie, requireUser } from '../../auth/cookie.js';
import { listLinkedProviders } from '../../auth/users.js';
import { listProviders } from '../../auth/providers.js';
import { db, schema } from '../../db/index.js';
import { env } from '../../env.js';
import { getPlatformSettings } from '../../auth/platformSettings.js';
import { demoStatus, isDemoUser } from '../../demo/demoAccount.js';
import { looksLikeEmail, needsName, publicName, suggestedName } from '../../utils/publicName.js';

const DISPLAY_NAME_MIN = 1;
const DISPLAY_NAME_MAX = 60;

export async function sessionRoutes(app: FastifyInstance) {
  app.get('/api/auth/me', async (req) => {
    if (!req.user) return { user: null };
    return {
      user: {
        id: req.user.id,
        email: req.user.email,
        displayName: req.user.displayName,
        // What other people see (live cursors use it), and whether to ask
        // "What should we call you?" (no name yet, or it's an email).
        publicName: publicName(req.user.id, req.user.displayName),
        needsName: needsName(req.user.displayName) && !isDemoUser(req.user),
        suggestedName: suggestedName(req.user.email),
        avatarUrl: req.user.avatarUrl,
        isDemoAccount: req.user.isDemoAccount,
        isGlobalAdmin: req.user.isGlobalAdmin,
        isModerator: req.user.isModerator,
        // On hold (read only) while a privacy request is looked at: the
        // pages say so, rather than each change failing on its own.
        restricted: !!req.user.restrictedAt,
        linkedProviders: await listLinkedProviders(req.user.id),
        // No password yet (e.g. a verification that asked them to choose
        // one): the account page offers to set one.
        hasPassword: !!req.user.passwordHash,
        // The demo banner: when this space ends, and how often the samples reset.
        ...(isDemoUser(req.user) ? { demo: { ...demoStatus(await getPlatformSettings()), expiresAt: req.user.demoExpiresAt?.getTime() ?? null } } : {}),
      },
    };
  });

  // Self-service display-name change. displayName has no DB-level
  // uniqueness constraint (see schema.ts's comment on users.displayName)
  // — it's a pure display label, never used as a lookup key anywhere
  // server-side (invites/collaborators resolve by email or id). A hard
  // "must be unique" requirement would need a migration + backfill for
  // little functional benefit, so this only validates shape (trimmed,
  // non-empty, bounded length) and leaves collisions cosmetic.
  app.patch<{ Body: { displayName?: string } }>('/api/auth/me', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const user = requireUser(req);
    if (isDemoUser(user)) return reply.code(403).send({ error: 'demo_account_cannot_change_profile' });
    const raw = req.body?.displayName;
    if (typeof raw !== 'string') return reply.code(400).send({ error: 'invalid_input' });
    const displayName = raw.trim();
    if (displayName.length < DISPLAY_NAME_MIN || displayName.length > DISPLAY_NAME_MAX) {
      return reply.code(400).send({ error: 'invalid_display_name' });
    }
    // Names are shown to other people: an email address doesn't belong there.
    if (looksLikeEmail(displayName)) return reply.code(400).send({ error: 'name_looks_like_email' });
    await db.update(schema.users).set({ displayName }).where(eq(schema.users.id, user.id));
    return { ok: true, displayName };
  });

  app.get('/api/auth/providers', async () => ({
    providers: listProviders(),
    passwordEnabled: env.enablePasswordAuth,
    // "Try the demo" shows only while an admin has the demo on.
    demoEnabled: (await getPlatformSettings()).demoEnabled,
  }));

  // ---- Profile › Browsers and devices: your own web sign-ins ----------------
  // (Desktop apps are the api_tokens list, /api/tokens.) Browser session
  // only; the shared demo account can't see or end anyone's.
  const currentSessionId = (req: import('fastify').FastifyRequest): string | null => {
    const token = req.cookies[SESSION_COOKIE];
    return token ? sessionIdForToken(token) : null;
  };

  app.get('/api/auth/sessions', async (req, reply) => {
    const user = requireUser(req);
    if (user.isDemoAccount) return reply.code(403).send({ error: 'demo_account_cannot_change_profile' });
    const here = currentSessionId(req);
    const rows = await db
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.userId, user.id), gte(schema.sessions.expiresAt, new Date())))
      .all();
    const sessions = rows
      .map((r) => ({
        id: publicSessionId(r.id),
        current: r.id === here,
        device: r.device,
        createdAt: r.createdAt.getTime(),
        lastUsedAt: r.lastUsedAt?.getTime() ?? null,
      }))
      .sort((a, b) => Number(b.current) - Number(a.current) || (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt));
    return { sessions };
  });

  /** Sign one of your browsers out (its open layouts close at once). */
  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async (req, reply) => {
    const user = requireUser(req);
    if (user.isDemoAccount) return reply.code(403).send({ error: 'demo_account_cannot_change_profile' });
    const rows = await db.select({ id: schema.sessions.id }).from(schema.sessions).where(eq(schema.sessions.userId, user.id)).all();
    const row = rows.find((r) => publicSessionId(r.id) === req.params.id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    await db.delete(schema.sessions).where(eq(schema.sessions.id, row.id));
    notifyCredentialRevoked({ sessionId: row.id });
    if (row.id === currentSessionId(req)) clearSessionCookie(reply);
    return { ok: true };
  });

  /** "Sign out of my other browsers": every web sign-in but this one. */
  app.post('/api/auth/sessions/sign-out-others', async (req, reply) => {
    const user = requireUser(req);
    if (user.isDemoAccount) return reply.code(403).send({ error: 'demo_account_cannot_change_profile' });
    const here = currentSessionId(req);
    if (!here) return reply.code(400).send({ error: 'browser_only' });
    return { ok: true, signedOut: await invalidateOtherSessions(user.id, here) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await invalidateSession(token);
    clearSessionCookie(reply);
    return { ok: true };
  });
}
