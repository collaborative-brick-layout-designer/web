// Module ownership transfer: to a club you're in, at once (Move to a
// club). Older servers also offered a person-to-person transfer by an
// emailed link; nothing offered it and it had no page, so it's gone. Any
// such transfer still pending is cleared when the module changes hands.

import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { checkGrowth } from '../limits/limits.js';
import { requireUser } from '../auth/cookie.js';
import { isDemoUser } from '../demo/demoAccount.js';
import { hasAtLeast, resolveResourceRole } from '../access/resolveResourceRole.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { can } from '../access/clubPermissions.js';
import { dropModuleFromCollections } from './collections.js';
import { trimmed } from '../utils/validate.js';
import { clearPendingModuleShares } from '../access/pendingShares.js';
import { syncModuleShareParts } from '../access/moduleShares.js';

interface InitiateTransferBody {
  recipientOrgSlug?: string;
}

export async function moduleTransferRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: InitiateTransferBody }>(
    '/api/modules/:id/transfer',
    async (req, reply) => {
      const user = requireUser(req);
      if (isDemoUser(user)) return reply.code(403).send({ error: 'demo_account_cannot_share' });
      const { role } = await resolveResourceRole(user.id, 'module', req.params.id);
      if (role === null) return reply.code(404).send({ error: 'not_found' });
      if (!hasAtLeast(role, 'owner')) {
        return reply.code(403).send({ error: 'forbidden' });
      }

      const recipientOrgSlug = trimmed(req.body.recipientOrgSlug)?.toLowerCase();
      if (!recipientOrgSlug) return reply.code(400).send({ error: 'transfer_to_club_only' });

      // Org recipient → immediate.
      if (recipientOrgSlug) {
        const dest = await db
          .select()
          .from(schema.orgs)
          .where(eq(schema.orgs.slug, recipientOrgSlug))
          .get();
        if (!dest) return reply.code(404).send({ error: 'recipient_org_not_found' });
        const myDestMembership = await db
          .select()
          .from(schema.orgMembers)
          .where(
            and(
              eq(schema.orgMembers.orgId, dest.id),
              eq(schema.orgMembers.userId, user.id),
            ),
          )
          .get();
        if (!myDestMembership) {
          return reply.code(403).send({ error: 'not_a_member_of_recipient_org' });
        }
        // Moving it in needs the club's adding permission.
        if (!(await can(user.id, dest.id, 'edit_modules'))) {
          return reply.code(403).send({ error: 'only_club_admins_can_add', permission: 'edit_modules' });
        }

        const module = await db
          .select()
          .from(schema.modules)
          .where(eq(schema.modules.id, req.params.id))
          .get();
        if (!module) return reply.code(404).send({ error: 'not_found' });
        if (module.ownerOrgId !== dest.id) {
          const refusal = await checkGrowth({ actor: user, owner: { kind: 'org', id: dest.id }, add: { bytes: (module.docSnapshot as Uint8Array).length + ((module.sidecarSnapshot as Uint8Array | null)?.length ?? 0) } });
          if (refusal) return reply.code(refusal.status).send(refusal.body);
        }

        await db
          .update(schema.modules)
          .set({
            ownerUserId: null,
            ownerOrgId: dest.id,
            updatedAt: new Date(),
          })
          .where(eq(schema.modules.id, req.params.id));
        // Ownership changed: pending user->user transfers issued by the
        // previous owner must not be redeemable any more.
        await clearPendingModuleShares(req.params.id);
        // It's the club's own now: a read-only share with that club says nothing more.
        await db
          .delete(schema.moduleClubShares)
          .where(and(eq(schema.moduleClubShares.moduleId, req.params.id), eq(schema.moduleClubShares.orgId, dest.id)));
        await syncModuleShareParts(req.params.id);
        // Moved out of a club: that club's collections lose it.
        if (module.ownerOrgId && module.ownerOrgId !== dest.id) {
          await dropModuleFromCollections(module, 'moved to another club', dest.id, user.id);
        }

        await writeAuditEvent({
          resourceKind: 'module',
          resourceId: req.params.id,
          userId: user.id,
          eventType: 'transfer',
          payload: {
            from: module.ownerUserId
              ? { kind: 'user', userId: module.ownerUserId }
              : { kind: 'org', orgId: module.ownerOrgId },
            to: { kind: 'org', orgId: dest.id, slug: dest.slug },
          },
        });

        return reply.send({ transferred: true, ownerKind: 'org', ownerSlug: dest.slug });
      }

      // Only to a club. Handing a module to one person by email had no
      // page to accept it on (and nothing offered it): it's gone; a copy
      // or a club does the job.
      return reply.code(400).send({ error: 'transfer_to_club_only' });
    },
  );
}
