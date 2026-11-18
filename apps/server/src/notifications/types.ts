// Every kind of notification, by its stable `type` string. The strings are
// an API (docs/notifications.md; the desktop app and the web's filters use
// them): add new ones, never rename or reuse one.
//
// `waits`: something waits for the person's answer (Accept / Decline), or a
// warning waits for "I understand". Web B's delivery defaults follow it.
// `action`: the inline answer POST /api/notifications/:id/act gives
// ('accept-decline'), or 'acknowledge' for warnings.

export const NOTIFICATION_CATEGORIES = ['moderation', 'clubs', 'sharing', 'shared_modules', 'account'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export interface NotificationTypeInfo {
  category: NotificationCategory;
  /** Plain words for filters and Settings. */
  label: string;
  waits: boolean;
  action?: 'accept-decline' | 'acknowledge';
}

export const NOTIFICATION_TYPES = {
  // ---- moderation (the warnings table) ----
  'moderation.warning': { category: 'moderation', label: 'Warnings', waits: true, action: 'acknowledge' },
  'moderation.final_warning': { category: 'moderation', label: 'Final warnings', waits: true, action: 'acknowledge' },
  'moderation.note': { category: 'moderation', label: 'Notes from the site team or a club', waits: false },

  // ---- clubs ----
  'club.join_request': { category: 'clubs', label: 'Requests to join a club you run', waits: true, action: 'accept-decline' },
  'club.join_approved': { category: 'clubs', label: 'Your request to join was approved', waits: false },
  'club.join_declined': { category: 'clubs', label: 'Your request to join was declined', waits: false },
  'club.invite': { category: 'clubs', label: 'Invites to join a club', waits: true, action: 'accept-decline' },
  'club.role_changed': { category: 'clubs', label: 'Your roles in a club changed', waits: false },
  'club.removed': { category: 'clubs', label: 'You were removed from a club', waits: false },
  'club.partner_request': { category: 'clubs', label: 'Partner requests', waits: true, action: 'accept-decline' },
  'club.partner_accepted': { category: 'clubs', label: 'Partner requests accepted', waits: false },
  'club.partner_declined': { category: 'clubs', label: 'Partner requests declined', waits: false },
  'club.partner_ended': { category: 'clubs', label: 'Partnerships ended', waits: false },
  'club.partner_deleted': { category: 'clubs', label: 'A partner club was deleted', waits: false },
  'club.offer_received': { category: 'clubs', label: 'Modules offered to your club', waits: true, action: 'accept-decline' },
  'club.offer_accepted': { category: 'clubs', label: 'Module offers accepted', waits: false },
  'club.offer_declined': { category: 'clubs', label: 'Module offers declined', waits: false },
  'club.item_returned': { category: 'clubs', label: 'Club things given back to their authors', waits: false },
  'club.deleted': { category: 'clubs', label: 'A club you’re in is being deleted', waits: false },
  'club.restored': { category: 'clubs', label: 'A club you’re in was restored', waits: false },

  // ---- sharing ----
  'sharing.layout_invite': { category: 'sharing', label: 'Invites to a layout', waits: true, action: 'accept-decline' },
  'sharing.module_invite': { category: 'sharing', label: 'Invites to a module', waits: true, action: 'accept-decline' },
  'sharing.part_invite': { category: 'sharing', label: 'Invites to a custom part', waits: true, action: 'accept-decline' },
  'sharing.transfer_offered': { category: 'sharing', label: 'Layouts offered to you', waits: true, action: 'accept-decline' },
  'sharing.transfer_accepted': { category: 'sharing', label: 'Layout hand-overs accepted', waits: false },
  'sharing.transfer_declined': { category: 'sharing', label: 'Layout hand-overs declined', waits: false },
  'sharing.module_shared': { category: 'sharing', label: 'Modules shared with you or your club', waits: false },
  'sharing.module_unshared': { category: 'sharing', label: 'Modules no longer shared', waits: false },

  // ---- shared modules ----
  'shared_modules.update_waiting': { category: 'shared_modules', label: 'Updates waiting in your layouts', waits: false },
  'shared_modules.updated': { category: 'shared_modules', label: 'Updates put in automatically', waits: false },

  // ---- account ----
  'account.export_ready': { category: 'account', label: 'Your data download is ready', waits: true },
  'account.deletion_scheduled': { category: 'account', label: 'Your account will be deleted', waits: false },
  'account.deletion_cancelled': { category: 'account', label: 'Your account will not be deleted', waits: false },
  'account.club_admin_inherited': { category: 'account', label: 'You became a club’s admin', waits: false },
  'account.restriction_placed': { category: 'account', label: 'Your account was put on hold', waits: false },
  'account.restriction_lifted': { category: 'account', label: 'Your account is no longer on hold', waits: false },
} as const satisfies Record<string, NotificationTypeInfo>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export function isNotificationType(v: unknown): v is NotificationType {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(NOTIFICATION_TYPES, v);
}

export function typeInfo(t: string): NotificationTypeInfo | null {
  return isNotificationType(t) ? NOTIFICATION_TYPES[t] : null;
}

/** The moderation type for a warning's severity. */
export function warningType(severity: 'note' | 'warning' | 'final'): NotificationType {
  return severity === 'warning' ? 'moderation.warning' : severity === 'final' ? 'moderation.final_warning' : 'moderation.note';
}
