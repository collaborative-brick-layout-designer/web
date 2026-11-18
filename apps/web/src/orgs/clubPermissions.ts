// What a club's roles let people do (the server's access/clubPermissions.ts).
// Each club sets up its own roles; a member's permissions are the union of
// the roles they hold. The server checks every action; the app only hides
// or explains what you can't do.

import type { ClubRole } from './clubRoles';

export type ClubPermission =
  | 'view_items'
  | 'edit_layouts'
  | 'start_layouts'
  | 'edit_modules'
  | 'add_parts'
  | 'manage_venues'
  | 'send_catalog'
  | 'invite'
  | 'manage_members'
  | 'export_data'
  | 'delete_items';

export interface PermissionInfo {
  value: ClubPermission;
  label: string;
  help: string;
}

export interface PermissionGroup {
  title: string;
  permissions: PermissionInfo[];
}

/** The tick boxes in the role editor, grouped, in plain words. */
export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    title: 'Layouts and things',
    permissions: [
      { value: 'view_items', label: 'View club items', help: 'Open and look at the club’s layouts, modules, venues and parts. Everyone in the club has this.' },
      { value: 'edit_layouts', label: 'Edit club layouts', help: 'Change the club’s layouts: add, move and remove parts, rulers and labels.' },
      { value: 'start_layouts', label: 'Start new club layouts', help: 'Make new layouts and collections for the club, or copy and move your own into it.' },
      { value: 'edit_modules', label: 'Add or edit modules', help: 'Save new modules to the club’s library and change the ones it has.' },
      { value: 'add_parts', label: 'Add parts', help: 'Upload custom parts for the club, and change the ones it has.' },
      { value: 'manage_venues', label: 'Manage venues', help: 'Add, change and delete the club’s venues (the halls layouts go in).' },
      { value: 'delete_items', label: 'Delete club items', help: 'Rename, share, hand over and delete the club’s layouts, modules and parts, give a thing back to the person who made it, and look after partner clubs and modules other clubs offer.' },
    ],
  },
  {
    title: 'Sharing',
    permissions: [
      { value: 'send_catalog', label: 'Send to the catalog', help: 'Share the club’s things in the public catalog, change their pictures, and make the club’s collections. In a trusted club, also review what members send.' },
    ],
  },
  {
    title: 'People',
    permissions: [
      { value: 'invite', label: 'Invite people', help: 'Invite people, answer requests to join, see the club’s activity, and remove or warn people whose roles can do less than yours.' },
      { value: 'manage_members', label: 'Manage members and roles', help: 'Give and take roles, remove anyone but an admin, and warn people. Only admins give the Admin role.' },
    ],
  },
  {
    title: 'The club’s data',
    permissions: [{ value: 'export_data', label: 'Download the club’s data', help: 'Ask for a download of everything the club has (its data export).' }],
  },
];

export const ALL_PERMISSIONS: ClubPermission[] = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.value));

export function permissionLabel(p: ClubPermission): string {
  return PERMISSION_GROUPS.flatMap((g) => g.permissions).find((x) => x.value === p)?.label ?? p;
}

/** The plain reason shown where something is refused or hidden. */
export function askForPermission(p: ClubPermission): string {
  return `Ask a club admin for the ${permissionLabel(p)} permission.`;
}

export function isClubPermission(v: unknown): v is ClubPermission {
  return typeof v === 'string' && (ALL_PERMISSIONS as string[]).includes(v);
}

/** What the old fixed roles gave, for servers older than club roles. */
function legacyPermissions(role: ClubRole | undefined, membersCanCreate = true): ClubPermission[] {
  if (role === 'admin') return ALL_PERMISSIONS;
  if (role === 'manager') return ALL_PERMISSIONS.filter((p) => p !== 'manage_members' && p !== 'export_data');
  if (role === 'member') return ['view_items', 'edit_layouts', ...(membersCanCreate ? (['start_layouts', 'edit_modules'] as const) : []), 'add_parts'];
  return [];
}

interface WithPermissions {
  myRole?: ClubRole;
  permissions?: ClubPermission[];
  canAdd?: boolean;
}

/** May I do `p` in this club? */
export function clubCan(org: WithPermissions | null | undefined, p: ClubPermission): boolean {
  if (!org) return false;
  const perms = org.permissions ?? legacyPermissions(org.myRole, org.canAdd !== false);
  return perms.includes(p);
}

/** Whether I run any part of the club (its Manage page has something for me). */
export function runsClub(org: (WithPermissions & { isAdmin?: boolean }) | null | undefined): boolean {
  return !!org && (org.isAdmin === true || org.myRole === 'admin' || clubCan(org, 'invite') || clubCan(org, 'manage_members') || clubCan(org, 'send_catalog'));
}

export type AddKind = 'layout' | 'module' | 'part' | 'venue' | 'collection';

/** The permission that adds a new thing of this kind to a club. */
export function addPermissionFor(kind: AddKind): ClubPermission {
  switch (kind) {
    case 'module':
      return 'edit_modules';
    case 'part':
      return 'add_parts';
    default:
      return 'start_layouts';
  }
}

/** May I add this kind of thing to the club? */
export function clubCanAdd(org: WithPermissions | null | undefined, kind: AddKind = 'layout'): boolean {
  if (kind === 'venue') return clubCan(org, 'start_layouts') || clubCan(org, 'manage_venues');
  return clubCan(org, addPermissionFor(kind));
}
