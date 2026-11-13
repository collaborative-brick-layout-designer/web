// Sharing a module with a person by an emailed invite link, the same way
// layouts are shared (collaborators.ts, invites.ts).
//
//   POST   /api/modules/:id/invites             invite an email (its owners)
//   DELETE /api/modules/:id/invites/:inviteId   cancel a pending invite
//   GET    /api/module-invites/:token           preview (no side effects)
//   POST   /api/module-invites/:token           accept (signed in)
//
// Inviting answers the same whether or not the email has an account here.
// Nobody is added until they accept: signed in with the invited email,
// verified, before it expires, once. The invite holds only while the person
// who sent it still manages the module's sharing, and pending invites go
// when the module changes hands (access/pendingShares.ts).

import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requireUser } from '../auth/cookie.js';
import { isDemoUser } from '../demo/demoAccount.js';
import { hasAtLeast, resolveResourceRole } from '../access/resolveResourceRole.js';
import { sendInviteEmailCapped } from '../email/inviteEmailCap.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { env } from '../env.js';
import { hasProvenEmail } from '../auth/users.js';
import { isValidEmail, normalizeEmail, sameEmail } from '../utils/validate.js';
import { publicName } from '../utils/publicName.js';
import { maskEmail } from '../utils/maskEmail.js';
import { perPerson } from '../utils/rateLimits.js';

const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

type ModuleInvite = typeof schema.moduleInvites.$inferSelect;

/** Why an invite can't be used, or null when it can. */
async function unusable(invite: ModuleInvite | undefined): Promise<{ code: number; error: string } | null> {
  if (!invite) return { code: 404, error: 'invite_not_found' };
  if (invite.acceptedAt) return { code: 410, error: 'invite_already_accepted' };
  if (invite.expiresAt.getTime() < Date.now()) return { code: 410, error: 'invite_expired' };
  const { role } = await resolveResourceRole(invite.invitedBy, 'module', invite.moduleId);
  if (!hasAtLeast(role, 'owner')) return { code: 410, error: 'module_invite_no_longer_valid' };
  return null;
}

async function inviteByToken(token: string): Promise<ModuleInvite | undefined> {
  return db.select().from(schema.moduleInvites).where(eq(schema.moduleInvites.token, token)).get();
}

export async function moduleInviteRoutes(app: FastifyInstance): Promise<void> {
  // ---- invite ----------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: { email?: unknown; role?: unknown } }>(
    '/api/modules/:id/invites',
    { config: { rateLimit: perPerson(20, '1 minute') } },
    async (req, reply) => {
      const user = requireUser(req);
      if (isDemoUser(user)) return reply.code(403).send({ error: 'demo_account_cannot_invite' });
      const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      if (!hasAtLeast(role, 'owner')) return reply.code(403).send({ error: 'forbidden' });
      const email = typeof req.body?.email === 'string' ? normalizeEmail(req.body.email) : '';
      if (!isValidEmail(email)) return reply.code(400).send({ error: 'invalid_email' });
      const inviteRole = req.body?.role;
      if (inviteRole !== 'viewer' && inviteRole !== 'editor') return reply.code(400).send({ error: 'invalid_role' });

      // Someone already on the list (whom the owner can see there) only
      // needs their role changed. Otherwise the answer is the same whether
      // or not the address has an account here.
      const existingUser = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(sql`lower(${schema.users.email}) = ${email}`)
        .get();
      if (existingUser && (await resolveResourceRole(existingUser.id, 'module', req.params.id)).role !== null) {
        return reply.code(409).send({ error: 'already_has_access' });
      }

      // A new invite to the same address replaces the one still waiting.
      await db
        .delete(schema.moduleInvites)
        .where(and(eq(schema.moduleInvites.moduleId, req.params.id), eq(schema.moduleInvites.invitedEmail, email), isNull(schema.moduleInvites.acceptedAt)));
      const token = randomBytes(24).toString('hex');
      const id = randomUUID();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
      await db.insert(schema.moduleInvites).values({
        id,
        moduleId: req.params.id,
        invitedEmail: email,
        role: inviteRole,
        token,
        invitedBy: user.id,
        expiresAt,
        acceptedAt: null,
        createdAt: now,
      });

      const inviteUrl = `${env.publicUrl}/module-invite/${token}`;
      const mail = await sendInviteEmailCapped(user, { to: email, inviteUrl, inviterName: publicName(user.id, user.displayName), what: 'module' });
      await writeAuditEvent({
        resourceKind: 'module',
        resourceId: req.params.id,
        userId: user.id,
        eventType: 'share',
        payload: { invitedEmail: email, role: inviteRole, inviteId: id },
      });
      return { id, token, inviteUrl, ...mail, expiresAt: expiresAt.getTime() };
    },
  );

  // ---- cancel ----------------------------------------------------------------
  app.delete<{ Params: { id: string; inviteId: string } }>('/api/modules/:id/invites/:inviteId', async (req, reply) => {
    const user = requireUser(req);
    const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
    if (role === null) return reply.code(404).send({ error: 'not_found' });
    if (!hasAtLeast(role, 'owner')) return reply.code(403).send({ error: 'forbidden' });
    await db
      .delete(schema.moduleInvites)
      .where(and(eq(schema.moduleInvites.id, req.params.inviteId), eq(schema.moduleInvites.moduleId, req.params.id)));
    return { ok: true };
  });

  // ---- preview ---------------------------------------------------------------
  app.get<{ Params: { token: string } }>('/api/module-invites/:token', async (req, reply) => {
    const invite = await inviteByToken(req.params.token);
    const bad = await unusable(invite);
    if (bad) return reply.code(bad.code).send({ error: bad.error });
    const module = await db
      .select({ title: schema.modules.title })
      .from(schema.modules)
      .where(eq(schema.modules.id, invite!.moduleId))
      .get();
    if (!module) return reply.code(404).send({ error: 'invite_not_found' });
    // Whoever holds the link sees a masked address, and whether the invite
    // is for the account they're signed in with.
    const forYou = req.user ? sameEmail(invite!.invitedEmail, req.user.email) : null;
    return {
      invitedEmail: forYou ? invite!.invitedEmail : maskEmail(invite!.invitedEmail),
      forYou,
      role: invite!.role,
      moduleId: invite!.moduleId,
      moduleTitle: module.title,
      expiresAt: invite!.expiresAt.getTime(),
    };
  });

  // ---- accept ----------------------------------------------------------------
  app.post<{ Params: { token: string } }>('/api/module-invites/:token', async (req, reply) => {
    const user = requireUser(req);
    const invite = await inviteByToken(req.params.token);
    const bad = await unusable(invite);
    if (bad) return reply.code(bad.code).send({ error: bad.error });
    const inv = invite!;
    if (!sameEmail(inv.invitedEmail, user.email)) return reply.code(403).send({ error: 'email_mismatch' });
    if (!hasProvenEmail(user)) return reply.code(403).send({ error: 'email_not_verified' });

    const now = new Date();
    // Single use: only the request that marks it accepted adds anyone.
    const claimed = await db
      .update(schema.moduleInvites)
      .set({ acceptedAt: now })
      .where(and(eq(schema.moduleInvites.id, inv.id), isNull(schema.moduleInvites.acceptedAt)))
      .returning({ id: schema.moduleInvites.id });
    if (claimed.length === 0) return reply.code(410).send({ error: 'invite_already_accepted' });
    await db
      .insert(schema.moduleCollaborators)
      .values({ moduleId: inv.moduleId, userId: user.id, role: inv.role, addedAt: now })
      .onConflictDoNothing();
    await writeAuditEvent({
      resourceKind: 'module',
      resourceId: inv.moduleId,
      userId: user.id,
      eventType: 'share',
      payload: { invitedEmail: inv.invitedEmail, role: inv.role, inviteId: inv.id, accepted: true },
    });
    return { moduleId: inv.moduleId, role: inv.role };
  });
}
