// Every API route plugin, in registration order. index.ts and the test
// that checks every changing route sends a live hint
// (events/routeHints.test.ts) share this one list.

import type { FastifyInstance } from 'fastify';
import { oauthRoutes } from './auth/oauth.js';
import { passwordRoutes } from './auth/password.js';
import { sessionRoutes } from './auth/session.js';
import { deviceRoutes } from './auth/device.js';
import { demoAuthRoutes } from './auth/demo.js';
import { tokenRoutes } from './tokens.js';
import { versionRoutes } from './version.js';
import { auditRoutes } from './audit.js';
import { adminRoutes } from './admin.js';
import { adminInsightsRoutes } from './adminInsights.js';
import { adminLimitsRoutes } from './adminLimits.js';
import { collaboratorRoutes } from './collaborators.js';
import { customPartRoutes } from './customParts.js';
import { customPartInviteRoutes } from './customPartInvites.js';
import { inviteRoutes } from './invites.js';
import { moduleInviteRoutes } from './moduleInvites.js';
import { layoutRoutes } from './layouts.js';
import { moduleRoutes } from './modules.js';
import { catalogRoutes } from './catalog.js';
import { collectionRoutes } from './collections.js';
import { itemCoverRoutes } from './itemCovers.js';
import { catalogDocRoutes } from './catalogDocs.js';
import { clubReviewRoutes } from './clubReview.js';
import { moduleTransferRoutes } from './moduleTransfers.js';
import { venueRoutes } from './venues.js';
import { trashRoutes } from './trash.js';
import { preferencesRoutes } from './preferences.js';
import { orgRoutes } from './orgs.js';
import { orgInviteRoutes } from './orgInvites.js';
import { clubJoinRoutes } from './clubJoin.js';
import { partsRoutes } from './parts.js';
import { partsManifestRoutes } from './partsManifest.js';
import { transferRoutes } from './transfers.js';
import { wsRoutes } from './ws.js';
import { eventRoutes } from './events.js';
import { warningRoutes } from './warnings.js';
import { ownershipRoutes } from './ownership.js';
import { privacyRoutes } from './privacy.js';
import { privacyAdminRoutes } from './privacyAdmin.js';
import { clubDeletionRoutes } from './clubDeletion.js';
import { clubLogoRoutes } from './clubLogos.js';

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  // A JSON body of `null`, a string or a number reads as an empty one:
  // routes read fields off their body, and `null.title` was a 500.
  app.addHook('preValidation', async (req) => {
    const type = req.headers['content-type'];
    if (typeof type !== 'string' || !/^application\/json\b/i.test(type)) return;
    if (req.body === null || (req.body !== undefined && typeof req.body !== 'object')) req.body = {};
  });
  await app.register(versionRoutes);
  await app.register(oauthRoutes);
  await app.register(passwordRoutes);
  await app.register(sessionRoutes);
  await app.register(deviceRoutes);
  await app.register(demoAuthRoutes);
  await app.register(tokenRoutes);
  await app.register(layoutRoutes);
  await app.register(partsRoutes);
  await app.register(collaboratorRoutes);
  await app.register(inviteRoutes);
  await app.register(moduleInviteRoutes);
  await app.register(customPartInviteRoutes);
  await app.register(orgRoutes);
  await app.register(orgInviteRoutes);
  await app.register(clubJoinRoutes);
  await app.register(transferRoutes);
  await app.register(customPartRoutes);
  await app.register(moduleRoutes);
  await app.register(catalogRoutes);
  await app.register(collectionRoutes);
  await app.register(itemCoverRoutes);
  await app.register(catalogDocRoutes);
  await app.register(clubReviewRoutes);
  await app.register(moduleTransferRoutes);
  await app.register(venueRoutes);
  await app.register(trashRoutes);
  await app.register(preferencesRoutes);
  await app.register(partsManifestRoutes);
  await app.register(auditRoutes);
  await app.register(adminRoutes);
  await app.register(adminInsightsRoutes);
  await app.register(adminLimitsRoutes);
  await app.register(wsRoutes);
  await app.register(eventRoutes);
  await app.register(warningRoutes);
  await app.register(ownershipRoutes);
  await app.register(privacyRoutes);
  await app.register(privacyAdminRoutes);
  await app.register(clubDeletionRoutes);
  await app.register(clubLogoRoutes);
}
