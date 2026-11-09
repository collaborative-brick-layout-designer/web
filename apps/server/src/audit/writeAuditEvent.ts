// Write an audit row. Centralised so the event_type strings stay
// consistent and the payload shape is one schema.
//
// Two call shapes:
//
//   writeAuditEvent({ layoutId, ... })        // legacy layout-only audits
//   writeAuditEvent({ resourceKind, resourceId, ... })  // generic
//
// Either layoutId OR (resourceKind+resourceId) must be set; never both.
// The schema column `layout_id` carries the layout-id form for backwards
// compatibility with existing queries; the generic form leaves it null
// and populates (resource_kind, resource_id) instead.

import { db, schema } from '../db/index.js';

export type AuditEventType =
  | 'open'
  | 'close'
  | 'edit'
  | 'share'
  | 'unshare'
  | 'role_change'
  | 'transfer'
  | 'import'
  | 'export'
  | 'rename'
  | 'create'
  | 'delete'
  // A club's admin changed its name, address, description or who may add things.
  | 'settings'
  // A club's admin handed the club to another member (they swap roles).
  | 'hand_over'
  // Joining a club without an invite: an open club's one-click join, and
  // an admin approving or declining someone's request to join.
  | 'join'
  | 'join_approve'
  | 'join_decline'
  // The live editor refused an update that would have merged another
  // layout into this one (ws/mergeGuard.ts), or applied one that looked
  // like it might (many clients the layout had never seen at once).
  | 'layout_merge_refused'
  | 'layout_merge_suspected'
  // The live editor refused an update the apps can't read (ws/updateGuard.ts),
  // or one that left too much waiting for changes the layout doesn't have
  // (ws/pending.ts). Once per connection.
  | 'layout_update_refused'
  // A module went back to an earlier version (as a new version).
  | 'restore_version'
  // A demo visitor's space deleted with everything in it (demo/reset.ts), with counts: one per space.
  | 'demo_space_deleted'
  // Its owner deleted a layout (routes/layouts.ts): who, its title, whose it was.
  | 'layout_delete'
  // Taken back out of Recently deleted (routes/trash.ts).
  | 'restore_deleted'
  // Platform-admin actions. Subject is the resource being modified
  // (`resourceKind: 'user' | 'org' | 'layout' | ...`); the userId
  // field on the event is the admin who performed the action.
  | 'admin_user_patch'
  | 'admin_user_delete'
  | 'admin_revoke_sessions'
  | 'admin_org_delete'
  | 'admin_layout_delete'
  | 'admin_global_part_create'
  | 'admin_global_part_delete'
  | 'admin_part_library_install'
  | 'admin_part_library_patch'
  | 'admin_part_library_update'
  | 'admin_part_library_delete'
  | 'org_part_library_toggle'
  | 'admin_settings_patch'
  | 'admin_demo_reset'
  // Usage limits: global values, a person's or club's override, and
  // suspending or lifting it (subject = the person or club).
  | 'admin_limits_patch'
  | 'admin_limits_override'
  | 'admin_suspend'
  | 'admin_unsuspend'
  // API tokens (desktop sign-in). Subject is the token's owner
  // (`resourceKind: 'user'`); the payload names the token.
  | 'api_token_issue'
  | 'api_token_revoke'
  // Public catalogs: sharing, reviewing and taking items down. Subject is
  // the catalog item (`resourceKind: 'catalog_item'`).
  | 'catalog_submit'
  | 'catalog_approve'
  | 'catalog_cover'
  | 'catalog_cover_approve'
  | 'catalog_cover_decline'
  | 'catalog_decline'
  | 'catalog_unpublish'
  | 'catalog_restore'
  | 'catalog_withdraw'
  | 'catalog_add'
  // Catalog collections: made or changed, reviewed, taken down, featured,
  // an item that left the catalog taken out, and "Add all". Subject is the
  // collection (`resourceKind: 'catalog_collection'`).
  | 'collection_submit'
  | 'collection_edit'
  | 'collection_withdraw'
  | 'collection_approve'
  | 'collection_decline'
  | 'collection_unpublish'
  | 'collection_restore'
  | 'collection_feature'
  | 'collection_item_removed'
  | 'collection_add'
  // Club collections: deleted by a curator, removed by a site moderator
  // (abuse), and pinned or unpinned for the club.
  | 'collection_delete'
  | 'collection_remove'
  | 'collection_pin'
  // Trusted clubs: a site admin or moderator trusts a club (its own admins
  // and managers then review what's published under its name) or stops.
  // Subject is the club.
  // Club roles (0035): a role made, changed (name or permissions) or
  // deleted, and given to or taken from a member (payload: roleId,
  // roleName, targetUserId). Subject is the club.
  | 'role_create'
  | 'role_edit'
  | 'role_delete'
  | 'role_assign'
  | 'role_unassign'
  | 'club_trust'
  | 'club_untrust'
  // Warnings: a site admin or moderator warned a person or club ('warn'),
  // a club's admin or manager warned a member ('club_warn'), and the
  // recipient said they read it ('warn_ack'). Subject is the person or club.
  | 'warn'
  | 'club_warn'
  | 'warn_ack'
  // "Dismiss all": every unread note at once (payload: warningIds).
  | 'warn_ack_all'
  // Author credit: a club's thing went back to the person who made it, by
  // them ('take_back') or by the club's admins and managers ('give_back').
  // The club keeps a copy (payload.keptCopyId). Subject is the original.
  | 'take_back'
  | 'give_back'
  // Privacy: a data download was asked for ('data_export', payload.reason
  // 'self' | 'admin' | 'club') or downloaded. Subject is the person or club.
  | 'data_export'
  | 'data_export_download'
  // Deleting an account: asked for (the waiting time starts), cancelled
  // by signing back in, and erased for good (payload.ref is the
  // "Deleted user #…" the site shows from then on; the erased account's
  // own rows carry it in actor_label).
  | 'deletion_request'
  | 'deletion_cancel'
  | 'account_erased'
  // Admin › Privacy requests: logged, changed, and each one-click answer
  // (payload.action: log, update, erase, restrict, unrestrict). Subject is
  // the person (or "request:<id>" when there is no account).
  | 'privacy_request'
  // Deleting a club: asked for (hidden, waiting), restored, and deleted for
  // good (payload.ref "Deleted club #…", what happened to its public items).
  | 'club_delete_request'
  | 'club_restore'
  // A club's logo set or removed by one of its admins.
  | 'club_logo_set'
  | 'club_logo_remove'
  | 'club_erased';

export type AuditResourceKind =
  | 'layout'
  | 'custom_part'
  | 'module'
  | 'venue'
  | 'org'
  | 'user'
  | 'part_library'
  | 'platform_settings'
  | 'catalog_item'
  | 'catalog_collection';

interface CommonAuditFields {
  /** null for system-driven events (TTL sweep, transfer admin). */
  userId: string | null;
  eventType: AuditEventType;
  payload: Record<string, unknown>;
  /** Snapshot version at the time of the event, when applicable. */
  docVersion?: number;
}

interface LayoutAuditEvent extends CommonAuditFields {
  layoutId: string;
}

interface GenericAuditEvent extends CommonAuditFields {
  resourceKind: AuditResourceKind;
  resourceId: string;
}

export type AuditEvent = LayoutAuditEvent | GenericAuditEvent;

export async function writeAuditEvent(event: AuditEvent): Promise<void> {
  const isLayout = 'layoutId' in event;
  await db.insert(schema.auditEvents).values({
    layoutId: isLayout ? event.layoutId : null,
    resourceKind: isLayout ? null : event.resourceKind,
    resourceId: isLayout ? null : event.resourceId,
    userId: event.userId,
    eventType: event.eventType,
    payload: JSON.stringify(event.payload),
    docVersion: event.docVersion ?? null,
    createdAt: new Date(),
  });
}
