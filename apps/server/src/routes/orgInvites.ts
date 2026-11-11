// Org-invite acceptance.
//
//   GET  /api/org-invites/:token    → preview (no side effects)
//   POST /api/org-invites/:token    → accept (auth required, email-match)
//   GET  /api/me/org-invites        → the open invites for my (verified) address
//
// Mirrors the layout-invite endpoints in routes/invites.ts. The demo
// account can't accept one: it never joins clubs.

import type { FastifyInstance } from 'fastify';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { clubAccess, setMemberRoles } from '../access/clubPermissions.js';
import { inviteRole, mayGiveRole } from './orgs.js';
import { checkGrowth } from '../limits/limits.js';
import { requireUser } from '../auth/cookie.js';
import { isDemoUser } from '../demo/demoAccount.js';
import { hasVerifiedEmail } from '../auth/users.js';
import { getPlatformSettings } from '../auth/platformSettings.js';
import { sameEmail } from '../utils/validate.js';
import { maskEmail } from '../utils/maskEmail.js';
import { publicName } from '../utils/publicName.js';

export async function orgInviteRoutes(app: FastifyInstance): Promise<void> {
  // Home's "You're invited to a club": the open invites for the signed-in
  // person's address, so someone with an account can join without the email.
  // Only for an account whose own address is confirmed, on a server that
  // asks for that (the list carries each invite's link, which is otherwise
  // only sent to the address), and never for a club waiting to be deleted.
  app.get('/api/me/org-invites', async (req) => {
    const user = requireUser(req);
    if (isDemoUser(user) || !user.emailVerified || !(await getPlatformSettings()).requireEmailVerification) return { invites: [] };
    const rows = await db
      .select({
        token: schema.orgInvites.token,
        orgId: schema.orgInvites.orgId,
        role: schema.orgInvites.role,
        roleId: schema.orgInvites.roleId,
        expiresAt: schema.orgInvites.expiresAt,
        orgName: schema.orgs.name,
        orgSlug: schema.orgs.slug,
        inviterId: schema.users.id,
        inviterName: schema.users.displayName,
      })
      .from(schema.orgInvites)
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.orgInvites.orgId))
      .leftJoin(schema.users, eq(schema.users.id, schema.orgInvites.invitedBy))
      .where(
        and(
          sql`lower(${schema.orgInvites.invitedEmail}) = ${user.email.trim().toLowerCase()}`,
          isNull(schema.orgInvites.acceptedAt),
          gt(schema.orgInvites.expiresAt, new Date()),
          isNull(schema.orgs.deletionDueAt),
        ),
      )
      .limit(50)
      .all();
    const invites = [];
    for (const r of rows) {
      invites.push({
        token: r.token,
        orgName: r.orgName,
        orgSlug: r.orgSlug,
        roleName: (await inviteRole(r.orgId, r))?.name ?? null,
        invitedBy: r.inviterId ? publicName(r.inviterId, r.inviterName) : null,
        expiresAt: r.expiresAt.getTime(),
      });
    }
    return { invites };
  });

  app.get<{ Params: { token: string } }>(
    '/api/org-invites/:token',
    async (req, reply) => {
      const invite = await db
        .select()
        .from(schema.orgInvites)
        .where(eq(schema.orgInvites.token, req.params.token))
        .get();
      if (!invite) return reply.code(404).send({ error: 'invite_not_found' });
      if (invite.acceptedAt) {
        return reply.code(410).send({ error: 'invite_already_accepted' });
      }
      if (invite.expiresAt.getTime() < Date.now()) {
        return reply.code(410).send({ error: 'invite_expired' });
      }
      const org = await db
        .select({ name: schema.orgs.name, slug: schema.orgs.slug, deletionDueAt: schema.orgs.deletionDueAt })
        .from(schema.orgs)
        .where(eq(schema.orgs.id, invite.orgId))
        .get();
      if (!org) return reply.code(404).send({ error: 'org_not_found' });
      // Kept, not thrown away: if the club is restored, the invite works again.
      if (org.deletionDueAt) return reply.code(409).send({ error: 'club_being_deleted' });

      // Whoever holds the link sees a masked address, and whether the
      // invite is for the account they're signed in with.
      const forYou = req.user ? sameEmail(invite.invitedEmail, req.user.email) : null;
      return {
        invitedEmail: forYou ? invite.invitedEmail : maskEmail(invite.invitedEmail),
        forYou,
        role: invite.role,
        // The role it gives, by the club's name for it (a Viewer, or a club's own role).
        roleName: (await inviteRole(invite.orgId, invite))?.name ?? null,
        orgId: invite.orgId,
        orgName: org.name,
        orgSlug: org.slug,
        expiresAt: invite.expiresAt.getTime(),
      };
    },
  );

  app.post<{ Params: { token: string } }>(
    '/api/org-invites/:token',
    async (req, reply) => {
      const user = requireUser(req);
      if (isDemoUser(user)) return reply.code(403).send({ error: 'demo_account_cannot_join_clubs' });
      const invite = await db
        .select()
        .from(schema.orgInvites)
        .where(eq(schema.orgInvites.token, req.params.token))
        .get();
      if (!invite) return reply.code(404).send({ error: 'invite_not_found' });
      if (invite.acceptedAt) {
        return reply.code(410).send({ error: 'invite_already_accepted' });
      }
      if (invite.expiresAt.getTime() < Date.now()) {
        return reply.code(410).send({ error: 'invite_expired' });
      }
      // Email-match security check (case-insensitive). Identical to the
      // layout-invite path — see the rationale in routes/invites.ts.
      if (!sameEmail(invite.invitedEmail, user.email)) {
        return reply.code(403).send({ error: 'email_mismatch' });
      }
      // The email match only proves anything if the account has proven
      // it controls that mailbox.
      if (!(await hasVerifiedEmail(user))) {
        return reply.code(403).send({ error: 'email_not_verified' });
      }
      // A club waiting to be deleted has no members, so the inviter's
      // authority can't be checked: say so and keep the invite (a restored
      // club's invites work again) rather than throwing it away.
      const club = await db.select({ deletionDueAt: schema.orgs.deletionDueAt }).from(schema.orgs).where(eq(schema.orgs.id, invite.orgId)).get();
      if (club?.deletionDueAt) return reply.code(409).send({ error: 'club_being_deleted' });

      // The invite carries its inviter's authority. If they have since
      // been demoted (below what the invite grants) or removed from the
      // org, the invite is void —
      // otherwise a removed admin's outstanding invites (possibly for
      // role 'admin') would still let people in.
      const inviter = await clubAccess(invite.invitedBy, invite.orgId);
      // The inviter must still be allowed to give the role (routes/orgs.ts mayGiveRole).
      const giving = await inviteRole(invite.orgId, invite);
      const stillAllowed = !!inviter && (inviter.permissions.has('invite') || inviter.permissions.has('manage_members')) && mayGiveRole(inviter, giving);
      if (!stillAllowed) {
        await db.delete(schema.orgInvites).where(eq(schema.orgInvites.id, invite.id));
        return reply.code(409).send({ error: 'invite_revoked' });
      }

      const already = await db
        .select({ role: schema.orgMembers.role })
        .from(schema.orgMembers)
        .where(and(eq(schema.orgMembers.orgId, invite.orgId), eq(schema.orgMembers.userId, user.id)))
        .get();
      if (!already) {
        const refusal = await checkGrowth({ actor: user, owner: { kind: 'org', id: invite.orgId }, add: { members: 1 } });
        if (refusal) return reply.code(refusal.status).send(refusal.body);
      }

      const now = new Date();
      await db
        .insert(schema.orgMembers)
        .values({
          orgId: invite.orgId,
          userId: user.id,
          role: invite.role,
          joinedAt: now,
        })
        .onConflictDoNothing();
      if (!already && giving) await setMemberRoles(invite.orgId, user.id, [giving.id]);
      // Any request to join is answered now.
      await db
        .delete(schema.orgJoinRequests)
        .where(and(eq(schema.orgJoinRequests.orgId, invite.orgId), eq(schema.orgJoinRequests.userId, user.id)));
      await db
        .update(schema.orgInvites)
        .set({ acceptedAt: now })
        .where(eq(schema.orgInvites.id, invite.id));

      return { orgId: invite.orgId, role: invite.role };
    },
  );
}
