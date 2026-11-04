// Everything the database holds about one person, table by table, for
// "Download my data" (and an admin answering a privacy request). Kept in
// step with docs/PRIVACY-DATA.md: a table that holds personal data and
// isn't read here is a bug (privacy.test.ts checks every table is either
// read here or listed as holding none).
//
// Rows come out as plain JSON: times as ISO 8601, pictures and documents
// as their size (the files themselves go in the zip's own folders), and
// secrets left out (password hashes, sign-in tokens, invite links): they
// are not "about" the person, and handing them out would let anyone
// holding the zip sign in.

import { and, eq, or, type SQL } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { db, schema } from '../db/index.js';

/** Columns never written to a download, whatever table they are in. */
const SECRET = new Set(['passwordHash', 'tokenHash', 'token', 'deviceCodeHash', 'userCodeHash', 'smtpPass', 'publicShareToken']);

/** Columns holding files; the download carries them as files instead. */
const BLOB = new Set(['docSnapshot', 'sidecarSnapshot', 'thumbnail', 'xmlBlob', 'spriteBlob', 'image', 'small', 'updateBytes']);

/** One row as plain JSON. */
export function plainRow(row: Record<string, unknown>, extraSecret: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (SECRET.has(k) || extraSecret.includes(k)) {
      if (v !== null && v !== undefined) out[k] = '(not included: a secret)';
      continue;
    }
    if (BLOB.has(k)) {
      out[k] = v ? { bytes: (v as Uint8Array).length } : null;
      continue;
    }
    if (v instanceof Date) out[k] = v.toISOString();
    else if (k === 'payload' || k === 'prefs' || k === 'limits' || k === 'data') out[k] = parseMaybe(v);
    else out[k] = v;
  }
  return out;
}

function parseMaybe(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export interface DataSection {
  /** The file name under data/, without .json. */
  name: string;
  /** One plain sentence: what these rows are. */
  about: string;
  rows: Record<string, unknown>[];
}

async function select(table: SQLiteTable, where: SQL | undefined): Promise<Record<string, unknown>[]> {
  return (await db.select().from(table).where(where).all()) as Record<string, unknown>[];
}

/**
 * Tables that hold no personal data at all, and why. Every other table in
 * the schema must be read by collectUserData (privacy.test.ts).
 */
export const NO_PERSONAL_DATA: Record<string, string> = {
  daily_stats: 'Daily site-wide counts only (requests, errors, active users as a number); never a person.',
  part_libraries: 'Installed part libraries: site data, not about anyone.',
  org_part_libraries: 'Which part libraries a club has switched on.',
  catalog_collection_items: 'Which public items are in a collection (the collection itself is listed under its curator).',
  catalog_collection_modules: 'Which modules are in a collection.',
  catalog_collection_parts: 'Which parts are in a collection.',
  layout_updates: 'Recent edits to a layout, waiting to be folded into it: part of the layout file, which is included.',
  orgs: 'Clubs: the club’s own data. A person’s memberships are listed under clubs.',
  club_logos: 'A club’s logo picture: the club’s own data (in the club’s download, as club-logo.webp).',
  club_roles: 'A club’s roles and what each allows: the club’s own data (in the club’s download). Who holds them is listed under club-roles.',
  platform_settings: 'Site settings. Only "who last changed them" points at a person, and that is listed under audit-log.',
  erasures: 'The record that an account or club was erased: a pseudonym ("Deleted user #abc123"), when, and how many things went. No personal data.',
  privacy_request_events: 'The history of a privacy request (listed under privacy-requests); the admin who acted is a site admin.',
  data_fixes: 'Which one-time data fixes the server has run, when, and how many values each changed: counts only, never a person.',
  __drizzle_migrations: 'The database’s own record of its upgrades.',
};

/** Every row about `userId`, by section. */
export async function collectUserData(userId: string): Promise<DataSection[]> {
  const s = schema;
  const user = await db.select().from(s.users).where(eq(s.users.id, userId)).get();
  if (!user) return [];
  const email = user.email;
  const plain = (rows: Record<string, unknown>[], extra: readonly string[] = []) => rows.map((r) => plainRow(r, extra));
  const sections: DataSection[] = [];
  const add = (name: string, about: string, rows: Record<string, unknown>[], extra: readonly string[] = []) =>
    sections.push({ name, about, rows: plain(rows, extra) });

  // ---- the account -------------------------------------------------------
  add('account', 'Your account: name, email, picture, and when you joined and were last seen. Your password is not included.', [
    { ...user, hasPassword: !!user.passwordHash },
  ]);
  add('sign-in-methods', 'Google, GitHub or other sign-ins linked to your account.', await select(s.oauthAccounts, eq(s.oauthAccounts.userId, userId)));
  add(
    'sessions',
    'Browsers you are signed in on, since when and until when. The sign-in keys themselves are not included.',
    await select(s.sessions, eq(s.sessions.userId, userId)),
    ['id'],
  );
  add('desktop-sign-ins', 'Desktop apps you signed in, with their names and when they were last used.', await select(s.apiTokens, eq(s.apiTokens.userId, userId)));
  add('desktop-sign-in-requests', 'Desktop sign-in codes you approved or turned down.', await select(s.deviceCodes, eq(s.deviceCodes.userId, userId)));
  add('email-confirmations', 'Links sent to confirm your email address that are still open.', await select(s.emailVerifications, eq(s.emailVerifications.userId, userId)));
  add('preferences', 'Your appearance and help settings.', await select(s.userPreferences, eq(s.userPreferences.userId, userId)));

  // ---- clubs ---------------------------------------------------------------
  const memberships = await db
    .select({ orgId: s.orgMembers.orgId, club: s.orgs.name, role: s.orgMembers.role, joinedAt: s.orgMembers.joinedAt })
    .from(s.orgMembers)
    .innerJoin(s.orgs, eq(s.orgs.id, s.orgMembers.orgId))
    .where(eq(s.orgMembers.userId, userId))
    .all();
  add('clubs', 'Clubs you are in, and your role in each.', memberships);
  add(
    'club-roles',
    'The roles you hold in each club.',
    (await db
      .select({ orgId: s.memberRoles.orgId, club: s.orgs.name, role: s.clubRoles.name })
      .from(s.memberRoles)
      .innerJoin(s.clubRoles, eq(s.clubRoles.id, s.memberRoles.roleId))
      .innerJoin(s.orgs, eq(s.orgs.id, s.memberRoles.orgId))
      .where(eq(s.memberRoles.userId, userId))
      .all()) as Record<string, unknown>[],
  );
  add('clubs-started', 'Clubs you started.', await select(s.orgs, eq(s.orgs.createdBy, userId)));
  add(
    'club-invites',
    'Invites to join a club sent to your email, and invites you sent.',
    await select(s.orgInvites, or(eq(s.orgInvites.invitedEmail, email), eq(s.orgInvites.invitedBy, userId))),
  );
  add('club-join-requests', 'Your requests to join clubs.', await select(s.orgJoinRequests, eq(s.orgJoinRequests.userId, userId)));

  // ---- layouts, modules, parts, venues ------------------------------------
  add(
    'layouts',
    'Layouts you own, and club layouts you made. Your own layouts are also in the layouts folder as files.',
    await select(s.layouts, or(eq(s.layouts.ownerUserId, userId), eq(s.layouts.createdBy, userId))),
  );
  add('layouts-shared-with-you', 'Other people’s layouts shared with you, and your role on each.', await select(s.layoutCollaborators, eq(s.layoutCollaborators.userId, userId)));
  add('layout-invites', 'Invites to a layout sent to your email.', await select(s.layoutInvites, eq(s.layoutInvites.invitedEmail, email)));
  add(
    'layout-transfers',
    'Layouts you offered to someone, or someone offered to you.',
    await select(s.layoutTransfers, or(eq(s.layoutTransfers.initiatedBy, userId), eq(s.layoutTransfers.recipientEmail, email))),
  );
  add(
    'modules',
    'Modules you own, and club modules you made. Your own modules are also in the modules folder as files.',
    await select(s.modules, or(eq(s.modules.ownerUserId, userId), eq(s.modules.createdBy, userId))),
  );
  add('module-versions', 'Module versions you saved.', await select(s.moduleVersions, eq(s.moduleVersions.authorId, userId)));
  add('modules-shared-with-you', 'Other people’s modules shared with you.', await select(s.moduleCollaborators, eq(s.moduleCollaborators.userId, userId)));
  add('module-invites', 'Invites to a module sent to your email.', await select(s.moduleInvites, eq(s.moduleInvites.invitedEmail, email)));
  add(
    'module-transfers',
    'Modules you offered to someone, or someone offered to you.',
    await select(s.moduleTransfers, or(eq(s.moduleTransfers.initiatedBy, userId), eq(s.moduleTransfers.recipientEmail, email))),
  );
  add(
    'custom-parts',
    'Parts you uploaded, and club parts you made. Your own are also in the parts folder.',
    await select(s.customParts, or(eq(s.customParts.ownerUserId, userId), eq(s.customParts.createdBy, userId))),
  );
  add('custom-parts-shared-with-you', 'Other people’s parts shared with you.', await select(s.customPartCollaborators, eq(s.customPartCollaborators.userId, userId)));
  add(
    'custom-part-invites',
    'Invites to a custom part you sent, or that were sent to your email.',
    await select(s.customPartInvites, or(eq(s.customPartInvites.invitedBy, userId), eq(s.customPartInvites.invitedEmail, email))),
  );
  add('custom-parts-with-a-set', 'Parts you have because a set made of them was shared with you.', await select(s.customPartSetShares, eq(s.customPartSetShares.userId, userId)));
  add(
    'venues',
    'Venues (rooms) you saved, and club venues you made. Your own are also in the venues folder.',
    await select(s.venueLibrary, or(eq(s.venueLibrary.ownerUserId, userId), eq(s.venueLibrary.createdBy, userId))),
  );

  // ---- the public catalog ---------------------------------------------------
  add('catalog-items', 'Modules, parts, layouts and venues you shared in the public catalog.', await select(s.catalogItems, eq(s.catalogItems.ownerUserId, userId)));
  add(
    'catalog-item-versions',
    'Versions you sent for review, or reviewed.',
    await select(s.catalogItemVersions, or(eq(s.catalogItemVersions.submittedBy, userId), eq(s.catalogItemVersions.decidedBy, userId))),
  );
  add('catalog-copies', 'Catalog items you added to your things.', await select(s.catalogCopies, eq(s.catalogCopies.userId, userId)));
  add('collections', 'Collections you curate.', await select(s.catalogCollections, eq(s.catalogCollections.ownerUserId, userId)));
  add('catalog-item-covers', 'Cover pictures you uploaded for catalog items (the pictures are in the covers folder).', await select(s.catalogItemCovers, eq(s.catalogItemCovers.createdBy, userId)));
  add('collection-covers', 'Cover pictures you uploaded (the pictures are in the covers folder).', await select(s.catalogCollectionCovers, eq(s.catalogCollectionCovers.createdBy, userId)));

  // ---- moderation, limits, records -------------------------------------------
  add(
    'notices',
    'Warnings and notes sent to you, and any you sent or read.',
    await select(s.warnings, or(eq(s.warnings.subjectUserId, userId), eq(s.warnings.issuedBy, userId), eq(s.warnings.acknowledgedBy, userId))),
  );
  add(
    'usage-limits',
    'Limits the site admins set for you, if any, and any you set as an admin.',
    await select(s.limitOverrides, or(and(eq(s.limitOverrides.subjectKind, 'user'), eq(s.limitOverrides.subjectId, userId)), eq(s.limitOverrides.updatedBy, userId))),
  );
  add(
    'usage-counts',
    'Daily counts of your requests and uploads (numbers only, no pages or addresses), kept for a short time to spot abuse.',
    await select(s.usageDaily, and(eq(s.usageDaily.subjectKind, 'user'), eq(s.usageDaily.subjectId, userId))),
  );
  add(
    'audit-log',
    'The site’s record of things you did (made, shared, deleted…) and things done to your account.',
    await select(
      s.auditEvents,
      or(eq(s.auditEvents.userId, userId), and(eq(s.auditEvents.resourceKind, 'user'), eq(s.auditEvents.resourceId, userId))),
    ),
  );
  add(
    'site-settings-changes',
    'If you are a site admin: when you last changed the site settings.',
    (await db.select({ updatedAt: s.platformSettings.updatedAt }).from(s.platformSettings).where(eq(s.platformSettings.updatedBy, userId)).all()) as Record<string, unknown>[],
  );
  add(
    'privacy-requests',
    'Privacy requests about you that the site admins logged, and what was done.',
    await select(s.privacyRequests, eq(s.privacyRequests.subjectUserId, userId)),
  );
  add(
    'data-downloads',
    'Downloads of your data, like this one.',
    await select(s.dataExports, or(and(eq(s.dataExports.subjectKind, 'user'), eq(s.dataExports.subjectId, userId)), eq(s.dataExports.requestedBy, userId))),
  );
  return sections;
}

/** Tables collectUserData reads (for the coverage test). */
export const READ_TABLES = [
  'users',
  'oauth_accounts',
  'sessions',
  'api_tokens',
  'device_codes',
  'email_verifications',
  'user_preferences',
  'org_members',
  'member_roles',
  'org_invites',
  'org_join_requests',
  'layouts',
  'layout_collaborators',
  'layout_invites',
  'layout_transfers',
  'modules',
  'module_versions',
  'module_collaborators',
  'module_transfers',
  'module_invites',
  'custom_parts',
  'custom_part_collaborators',
  'custom_part_invites',
  'custom_part_set_shares',
  'venue_library',
  'catalog_items',
  'catalog_item_versions',
  'catalog_copies',
  'catalog_collections',
  'catalog_collection_covers',
  'catalog_item_covers',
  'warnings',
  'limit_overrides',
  'usage_daily',
  'audit_events',
  'data_exports',
  'privacy_requests',
];

/** Every row about a club, for a club admin's "Download the club's data". */
export async function collectOrgData(orgId: string): Promise<DataSection[]> {
  const s = schema;
  const org = await db.select().from(s.orgs).where(eq(s.orgs.id, orgId)).get();
  if (!org) return [];
  const sections: DataSection[] = [];
  const add = (name: string, about: string, rows: Record<string, unknown>[]) => sections.push({ name, about, rows: rows.map((r) => plainRow(r)) });
  add('club', 'The club: its name, address, description and settings.', [org as unknown as Record<string, unknown>]);
  add(
    'members',
    'Its members, their roles and when they joined.',
    (await db
      .select({ userId: s.orgMembers.userId, name: s.users.displayName, email: s.users.email, role: s.orgMembers.role, joinedAt: s.orgMembers.joinedAt })
      .from(s.orgMembers)
      .innerJoin(s.users, eq(s.users.id, s.orgMembers.userId))
      .where(eq(s.orgMembers.orgId, orgId))
      .all()) as Record<string, unknown>[],
  );
  add('roles', 'Its roles and what each allows.', await select(s.clubRoles, eq(s.clubRoles.orgId, orgId)));
  add(
    'member-roles',
    'Which roles each member holds.',
    (await db
      .select({ userId: s.memberRoles.userId, roleId: s.memberRoles.roleId, role: s.clubRoles.name })
      .from(s.memberRoles)
      .innerJoin(s.clubRoles, eq(s.clubRoles.id, s.memberRoles.roleId))
      .where(eq(s.memberRoles.orgId, orgId))
      .all()) as Record<string, unknown>[],
  );
  add('invites', 'Invites to join that are still open or were used.', await select(s.orgInvites, eq(s.orgInvites.orgId, orgId)));
  add('join-requests', 'People asking to join.', await select(s.orgJoinRequests, eq(s.orgJoinRequests.orgId, orgId)));
  add('layouts', 'The club’s layouts (the files are in the layouts folder).', await select(s.layouts, eq(s.layouts.ownerOrgId, orgId)));
  add('modules', 'The club’s modules (the files are in the modules folder).', await select(s.modules, eq(s.modules.ownerOrgId, orgId)));
  add('custom-parts', 'The club’s custom parts (in the parts folder).', await select(s.customParts, eq(s.customParts.ownerOrgId, orgId)));
  add('venues', 'The club’s venues (in the venues folder).', await select(s.venueLibrary, eq(s.venueLibrary.ownerOrgId, orgId)));
  add('catalog-items', 'What the club shared in the public catalog.', await select(s.catalogItems, eq(s.catalogItems.ownerOrgId, orgId)));
  add('collections', 'The club’s collections.', await select(s.catalogCollections, eq(s.catalogCollections.orgId, orgId)));
  add('part-libraries', 'Which part libraries the club switched on or off.', await select(s.orgPartLibraries, eq(s.orgPartLibraries.orgId, orgId)));
  add(
    'notices',
    'Warnings to the club, and notes and warnings the club sent its members.',
    await select(s.warnings, or(eq(s.warnings.subjectOrgId, orgId), eq(s.warnings.clubOrgId, orgId))),
  );
  add('usage-limits', 'Limits the site admins set for the club, if any.', await select(s.limitOverrides, and(eq(s.limitOverrides.subjectKind, 'org'), eq(s.limitOverrides.subjectId, orgId))));
  add('usage-counts', 'Daily counts of the club’s uploads and share-link views.', await select(s.usageDaily, and(eq(s.usageDaily.subjectKind, 'org'), eq(s.usageDaily.subjectId, orgId))));
  add('audit-log', 'The record of what happened in the club.', await select(s.auditEvents, and(eq(s.auditEvents.resourceKind, 'org'), eq(s.auditEvents.resourceId, orgId))));
  return sections;
}
