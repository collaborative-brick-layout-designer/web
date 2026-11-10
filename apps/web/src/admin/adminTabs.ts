// The admin page's tabs, shared with the header's Settings menu (one
// entry per tab) without loading the admin page itself. The tab is in
// the address (/admin?tab=users) so links and back/forward work.

export type AdminTab = 'dashboard' | 'heavy' | 'users' | 'orgs' | 'layouts' | 'parts' | 'libraries' | 'moderation' | 'privacy' | 'audit' | 'settings';

export const ADMIN_TABS: readonly AdminTab[] = ['dashboard', 'heavy', 'users', 'orgs', 'layouts', 'parts', 'libraries', 'moderation', 'privacy', 'audit', 'settings'];

/** The Settings menu's words for each tab. */
export const ADMIN_MENU_LABELS: Record<AdminTab, string> = {
  dashboard: 'Dashboard',
  heavy: 'Heavy use',
  users: 'Users',
  orgs: 'Clubs',
  layouts: 'Layouts',
  parts: 'Parts',
  libraries: 'Parts library',
  moderation: 'Moderation',
  privacy: 'Privacy requests',
  audit: 'Audit log',
  settings: 'Site settings',
};

/** The side list's groups, each under a small heading, in order. */
export const ADMIN_GROUPS: readonly { label: string; tabs: readonly AdminTab[] }[] = [
  { label: 'Overview', tabs: ['dashboard', 'heavy'] },
  { label: 'People', tabs: ['users', 'orgs'] },
  { label: 'Content', tabs: ['layouts', 'parts', 'libraries'] },
  { label: 'Requests', tabs: ['moderation', 'privacy'] },
  { label: 'Site', tabs: ['audit', 'settings'] },
];

/** The side list's words for each section. */
export const ADMIN_NAV_LABELS: Record<AdminTab, string> = { ...ADMIN_MENU_LABELS, settings: 'Settings' };

export function adminTabUrl(t: AdminTab): string {
  return `/admin?tab=${t}`;
}

/** The tabs someone may open: everything for an admin, Moderation for a moderator. */
export function adminTabsFor(user: { isGlobalAdmin: boolean; isModerator?: boolean }): readonly AdminTab[] {
  if (user.isGlobalAdmin) return ADMIN_TABS;
  return user.isModerator ? ['moderation'] : [];
}
