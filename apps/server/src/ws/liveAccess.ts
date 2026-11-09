// Access changes that open live connections must see right away, not at
// their next periodic check: a collaborator's role changed or removed, a
// club member's role changed or removed, a layout moved to another owner,
// a person or club suspended or let back. The routes that make the change
// call notifyAccessChanged; every open connection it may concern checks
// its access again at once (ws/handler.ts).

import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { isSuspended } from '../limits/limits.js';

export type AccessChange =
  /** Something about one person's access (their club role, their account). */
  | { userId: string }
  /** Something about who may open one layout (its collaborators, its owner). */
  | { layoutId: string }
  /** Anything else (a suspension: of a person, or a club and every layout it owns). */
  | { all: true };

const listeners = new Set<(c: AccessChange) => void>();

export function onAccessChanged(listener: (c: AccessChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notifyAccessChanged(c: AccessChange): void {
  for (const l of listeners) {
    try {
      l(c);
    } catch {
      /* one connection's failure must not break the route */
    }
  }
}

/** Whether a change concerns a connection of `userId` to `layoutId`. */
export function concerns(c: AccessChange, userId: string, layoutId: string): boolean {
  if ('all' in c) return true;
  if ('userId' in c) return c.userId === userId;
  return c.layoutId === layoutId;
}

/**
 * A suspended person, or a layout whose owner (person or club) is
 * suspended, is read-only live, whether or not usage limits are enforced.
 */
export async function suspendedIn(userId: string, layoutId: string): Promise<boolean> {
  if (isSuspended('user', userId)) return true;
  const owner = await db
    .select({ ownerUserId: schema.layouts.ownerUserId, ownerOrgId: schema.layouts.ownerOrgId })
    .from(schema.layouts)
    .where(eq(schema.layouts.id, layoutId))
    .get();
  if (owner?.ownerOrgId) return isSuspended('org', owner.ownerOrgId);
  return owner?.ownerUserId ? isSuspended('user', owner.ownerUserId) : false;
}
