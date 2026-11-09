// One seeded database for the route-by-route security probes
// (security/routeProbes.test.ts): an owner with one of everything, a
// stranger, a site admin, a moderator and the demo account, and the
// concrete URL each route pattern is probed at (the owner's things).

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { encodeDoc, createDefaultLayoutDoc } from '@cld/ydoc';
import { db, issueToken, loginAs, resetDb, schema } from './helpers.js';
import { sqlite } from '../db/index.js';

export type Who = { cookie: string; id: string };

export interface ProbeWorld {
  olive: Who;
  stranger: Who;
  /** A plain member of Olive's club. */
  member: Who;
  /** Someone Olive's layout, module and part are shared with as a viewer. */
  viewer: Who;
  root: Who;
  mod: Who;
  demoCookie: string;
  /** A desktop token of the stranger's with only the account:prefs scope. */
  prefsOnlyToken: string;
  ids: Record<string, string>;
}

const cookieOf = (sc: string | string[] | undefined) => (Array.isArray(sc) ? sc.join('; ') : (sc ?? ''));

export async function seedProbeWorld(app: FastifyInstance): Promise<ProbeWorld> {
  resetDb();
  sqlite.exec(`
    DELETE FROM data_exports; DELETE FROM erasures; DELETE FROM privacy_request_events; DELETE FROM privacy_requests;
    DELETE FROM catalog_collection_items; DELETE FROM catalog_collection_modules; DELETE FROM catalog_collection_parts;
    DELETE FROM catalog_collection_covers; DELETE FROM catalog_item_covers; DELETE FROM catalog_copies;
    DELETE FROM catalog_item_versions; DELETE FROM catalog_collections; DELETE FROM catalog_items;
    DELETE FROM venue_library; DELETE FROM module_versions;
  `);
  const olive = await loginAs(app, 'olive@example.com');
  const stranger = await loginAs(app, 'sid@example.com');
  const member = await loginAs(app, 'mem@example.com');
  const viewer = await loginAs(app, 'vi@example.com');
  const root = await loginAs(app, 'root@example.com');
  const mod = await loginAs(app, 'mo@example.com');
  await db.update(schema.users).set({ isGlobalAdmin: true }).where(eq(schema.users.id, root.id));
  await db.update(schema.users).set({ isModerator: true }).where(eq(schema.users.id, mod.id));
  const prefsOnlyToken = await issueToken(app, stranger.cookie, 'account:prefs');
  await issueToken(app, olive.cookie);
  const oliveToken = (await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.userId, olive.id)).get())!.id;

  // The demo account, switched on and signed in.
  await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: { cookie: root.cookie }, payload: { demoEnabled: true, moduleCatalogEnabled: true, partsCatalogEnabled: true, layoutCatalogEnabled: true, venueCatalogEnabled: true } });
  const demo = await app.inject({ method: 'POST', url: '/api/auth/demo', payload: {} });
  const demoCookie = cookieOf(demo.headers['set-cookie']);

  const now = new Date();
  const doc = Buffer.from(encodeDoc(createDefaultLayoutDoc()));
  const club = randomUUID();
  await db.insert(schema.orgs).values({ id: club, name: 'Olive Club', slug: 'olive-club', createdAt: now, createdBy: olive.id, listed: true, joinPolicy: 'request' });
  await db.insert(schema.orgMembers).values({ orgId: club, userId: olive.id, role: 'admin', joinedAt: now });
  await db.insert(schema.orgMembers).values({ orgId: club, userId: member.id, role: 'member', joinedAt: now });
  const layout = randomUUID();
  await db.insert(schema.layouts).values({ id: layout, title: 'Olive yard', ownerUserId: olive.id, createdBy: olive.id, createdAt: now, updatedAt: now, docSnapshot: doc });
  const mod1 = randomUUID();
  await db.insert(schema.modules).values({ id: mod1, title: 'Olive module', ownerUserId: olive.id, createdBy: olive.id, docSnapshot: doc, latestVersion: 1, createdAt: now, updatedAt: now });
  await db.insert(schema.moduleVersions).values({ id: randomUUID(), moduleId: mod1, version: 1, docSnapshot: doc, authorId: olive.id, createdAt: now });
  const part = randomUUID();
  await db.insert(schema.customParts).values({
    id: part,
    partNumber: 'OLIVE.1',
    displayName: 'Olive part',
    ownerUserId: olive.id,
    createdBy: olive.id,
    xmlBlob: Buffer.from('<part><Author>olive</Author></part>'),
    spriteBlob: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    spriteMime: 'image/png',
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.layoutCollaborators).values({ layoutId: layout, userId: viewer.id, role: 'viewer', addedAt: now });
  await db.insert(schema.moduleCollaborators).values({ moduleId: mod1, userId: viewer.id, role: 'viewer', addedAt: now });
  await db.insert(schema.customPartCollaborators).values({ customPartId: part, userId: viewer.id, role: 'viewer', addedAt: now });
  const venue = randomUUID();
  await db.insert(schema.venueLibrary).values({ id: venue, ownerUserId: olive.id, name: 'Olive hall', data: JSON.stringify({ name: 'Olive hall', enabled: true, edges: [], obstacles: [] }), createdBy: olive.id, createdAt: now });
  // A catalog item of the club's in review, and its version; a collection of Olive's.
  const item = randomUUID();
  await db.insert(schema.catalogItems).values({ id: item, kind: 'module', sourceId: mod1, ownerOrgId: club, title: 'Olive item', status: 'in_review', createdAt: now, updatedAt: now });
  const version = randomUUID();
  await db.insert(schema.catalogItemVersions).values({ id: version, itemId: item, version: 1, status: 'in_review', docSnapshot: doc, submittedBy: olive.id, createdAt: now } as never);
  // And one of Olive's that is public.
  const publicItem = randomUUID();
  await db.insert(schema.catalogItems).values({ id: publicItem, kind: 'module', sourceId: mod1, ownerUserId: olive.id, title: 'Olive public', status: 'public', publicVersion: 1, createdAt: now, updatedAt: now });
  await db.insert(schema.catalogItemVersions).values({ id: randomUUID(), itemId: publicItem, version: 1, status: 'public', docSnapshot: doc, submittedBy: olive.id, createdAt: now } as never);
  const collection = randomUUID();
  await db.insert(schema.catalogCollections).values({ id: collection, title: 'Olive picks', ownerUserId: olive.id, orgId: club, status: 'in_review', audience: 'everyone', createdAt: now, updatedAt: now });
  const notice = randomUUID();
  await db.insert(schema.warnings).values({ id: notice, scope: 'site', severity: 'note', reason: 'Hello', subjectUserId: olive.id, createdAt: now } as never);
  const dataExport = randomUUID();
  await db.insert(schema.dataExports).values({ id: dataExport, subjectKind: 'user', subjectId: olive.id, reason: 'self', status: 'ready', requestedBy: olive.id, createdAt: now } as never);
  const request = randomUUID();
  await db.insert(schema.privacyRequests).values({ id: request, type: 'access', receivedVia: 'email', receivedAt: now, dueAt: now, status: 'open', subjectUserId: olive.id, createdAt: now, updatedAt: now } as never);
  const invite = randomUUID();
  await db.insert(schema.layoutInvites).values({ id: invite, layoutId: layout, invitedEmail: 'x@example.com', role: 'viewer', token: `inv-${invite}`, invitedBy: olive.id, expiresAt: new Date(now.getTime() + 86_400_000) });
  const moduleInvite = randomUUID();
  await db.insert(schema.moduleInvites).values({ id: moduleInvite, moduleId: mod1, invitedEmail: 'x@example.com', role: 'viewer', token: `minv-${moduleInvite}`, invitedBy: olive.id, expiresAt: new Date(now.getTime() + 86_400_000), createdAt: now });
  const partInvite = randomUUID();
  await db.insert(schema.customPartInvites).values({ id: partInvite, customPartId: part, invitedEmail: 'x@example.com', role: 'viewer', token: `pinv-${partInvite}`, invitedBy: olive.id, expiresAt: new Date(now.getTime() + 86_400_000), createdAt: now });
  const orgInvite = randomUUID();
  await db.insert(schema.orgInvites).values({ id: orgInvite, orgId: club, invitedEmail: 'y@example.com', role: 'member', token: `oinv-${orgInvite}`, invitedBy: olive.id, expiresAt: new Date(now.getTime() + 86_400_000), createdAt: now } as never);
  const transfer = randomUUID();
  await db.insert(schema.layoutTransfers).values({ id: transfer, layoutId: layout, initiatedBy: olive.id, recipientEmail: 'z@example.com', token: `tr-${transfer}`, expiresAt: new Date(now.getTime() + 86_400_000), createdAt: now });
  const joinRequest = randomUUID();
  await db.insert(schema.orgJoinRequests).values({ id: joinRequest, orgId: club, userId: root.id, createdAt: now } as never);

  return {
    olive,
    stranger,
    member,
    viewer,
    root,
    mod,
    demoCookie,
    prefsOnlyToken,
    ids: { club, layout, module: mod1, part, venue, item, publicItem, version, collection, notice, dataExport, request, invite, moduleInvite, partInvite, orgInvite, transfer, joinRequest, oliveToken },
  };
}

/** The URL a route pattern is probed at: the owner's things in place of each parameter. */
export function concreteUrl(pattern: string, w: ProbeWorld, override?: string): string {
  const i = w.ids;
  return pattern.replace(/:([A-Za-z]+)/g, (_m, name: string, offset: number) => {
    if (override !== undefined) return override;
    const before = pattern.slice(0, offset);
    switch (name) {
      case 'slug':
        return before.endsWith('/libraries/') ? 'no-such-library' : 'olive-club';
      case 'userId':
        return w.olive.id;
      case 'inviteId':
        return before.startsWith('/api/orgs') ? i.orgInvite! : before.startsWith('/api/modules') ? i.moduleInvite! : before.startsWith('/api/custom-parts') ? i.partInvite! : i.invite!;
      case 'transferId':
        return i.transfer!;
      case 'n':
        return '1';
      case 'versionId':
        return i.version!;
      case 'roleId':
        return `${i.club}:member`;
      case 'libraryId':
        return 'no-such-library';
      case 'copyId':
        return 'no-such-copy';
      case 'token':
        return 'no-such-token';
      case 'id':
        break;
      default:
        return `unknown-${name}`;
    }
    const pick: [string, string][] = [
      ['/api/layouts/', i.layout!],
      ['/api/modules/', i.module!],
      ['/api/custom-parts/', i.part!],
      ['/api/venues/', i.venue!],
      ['/api/catalog/items/', i.publicItem!],
      ['/api/catalog/collections/', i.collection!],
      ['/api/moderation/items/', i.item!],
      ['/api/moderation/collections/', i.collection!],
      ['/api/admin/users/', w.olive.id],
      ['/api/admin/orgs/', i.club!],
      ['/api/admin/layouts/', i.layout!],
      ['/api/admin/global-parts/', i.part!],
      ['/api/admin/part-libraries/', 'no-such-library'],
      ['/api/admin/privacy/requests/', i.request!],
      ['/api/tokens/', i.oliveToken!],
      ['/api/notices/', i.notice!],
      ['/api/privacy/exports/', i.dataExport!],
      ['/api/orgs/olive-club/join-requests/', i.joinRequest!],
      ['/api/orgs/olive-club/review/versions/', i.version!],
      ['/api/orgs/olive-club/review/items/', i.item!],
      ['/api/orgs/olive-club/review/collections/', i.collection!],
    ];
    const resolved = before.replace(/:slug/g, 'olive-club');
    const hit = pick.find(([p]) => resolved.startsWith(p) && resolved.length === p.length);
    return hit ? hit[1] : `unmapped-${resolved}`;
  });
}
