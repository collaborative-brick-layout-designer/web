// The name other people see for someone.
//
// Older accounts got their email address as their display name (email
// sign-up had no name field, and Google sign-in fell back to the email),
// and display names show up in club member lists, live cursors, the
// public catalog's "by" lines and invite emails. So every place that
// shows another person's name goes through `publicName`: a name that
// looks like an email (or is empty) becomes "Builder #abc123" instead.
// Only the person themselves and site admins see the stored name as is
// (`nameFor`). Stored names are never rewritten: the person is asked for
// a name after they next sign in (see `needsName`).

/** Anything with an '@' could be an address; names don't need one. */
/** The longest display name an account may have (Profile refuses a longer one). */
export const DISPLAY_NAME_MAX = 60;

export function looksLikeEmail(name: string | null | undefined): boolean {
  return !!name && name.includes('@');
}

/** True when the stored name is empty or looks like an email: ask for a real one. */
export function needsName(name: string | null | undefined): boolean {
  return !name || !name.trim() || looksLikeEmail(name);
}

/** "Builder #abc123": stable for one account, says nothing about who it is. */
export function fallbackName(userId: string): string {
  return `Builder #${userId.replace(/[^0-9a-z]/gi, '').slice(0, 6).toLowerCase()}`;
}

/** The name anyone else may see for this person. */
export function publicName(userId: string, name: string | null | undefined): string {
  return needsName(name) ? fallbackName(userId) : name!.trim();
}

/** The name `viewer` may see: the stored one for themselves and site admins, else `publicName`. */
export function nameFor(
  viewer: { id: string; isGlobalAdmin?: boolean } | null | undefined,
  userId: string,
  name: string | null | undefined,
): string {
  if (viewer && (viewer.id === userId || viewer.isGlobalAdmin) && name?.trim()) return name;
  return publicName(userId, name);
}

/**
 * Whether `viewer` may see the email addresses on a share list: the people
 * who manage sharing (the owners) and site admins. Everyone else sees
 * names only (each person still sees their own address).
 */
export function emailsVisible(viewer: { isGlobalAdmin?: boolean }, role: 'owner' | 'editor' | 'viewer' | null): boolean {
  return role === 'owner' || !!viewer.isGlobalAdmin;
}

/** A suggestion for the "What should we call you?" prompt: the part of the email before '@'. */
export function suggestedName(email: string): string {
  return (email.split('@')[0] ?? '').replace(/[._+-]+/g, ' ').trim().slice(0, 60);
}
