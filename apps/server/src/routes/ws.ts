// WebSocket route at `/ws/layout/:id`.
//
// Auth: the session cookie is sent automatically with the WS handshake
// because @fastify/websocket runs through the same HTTP pipeline. We
// reuse `attachUser` (same as REST) to populate `req.user` and reject
// the upgrade if the user lacks at least viewer role. Non-browser
// clients (the desktop app) instead send `Authorization: Bearer
// bld_pat_…` on the upgrade request; this route is on the API-token
// allow-list, and a token without `layouts:write` is held to viewer.
// Tokens are never read from the query string.
//
// Cookie-authenticated handshakes must come from our own origin: a
// browser attaches the session cookie to a WebSocket opened by ANY page
// (WebSockets aren't subject to CORS), so without this check another
// site could open a socket as the signed-in user (cross-site WebSocket
// hijacking). Browsers can't set Authorization on a WebSocket, so
// token handshakes carry no such ambient credential and skip the check.
//
// Phase 5 will distinguish viewer (read-only WS) from editor (writable);
// for Phase 4 we accept any role >= viewer and let the editor's REST
// endpoints gate write actions. Per-message viewer enforcement is
// stubbed in `handler.ts` and lands when sharing UIs do.

import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { docHub } from '../ws/docHub.js';
import { attachWsHandlers, earlyMessages } from '../ws/handler.js';
import { hasAtLeast, resolveResourceRole } from '../access/resolveResourceRole.js';
import { SESSION_COOKIE, sessionIdForToken } from '../auth/session.js';
import { onCredentialRevoked } from '../auth/revocation.js';
import { isRevokedBy, revokedReason, type Credential } from '../auth/credentials.js';
import { bearerToken } from '../auth/cookie.js';
import { hasScope } from '../auth/apiTokens.js';
import { blockedDesktopMinimum } from '../compat.js';
import { env } from '../env.js';
import { rollup } from '../metrics/rollup.js';
import { globalLimits, limitsEnforced, overrideFor } from '../limits/limits.js';
import { touchLayoutOpened } from '../metrics/activity.js';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

// Per-user cap on concurrent WS connections. Prevents one tab fork-bomb
// from exhausting the server. 8 is enough for a normal user across a
// few browser tabs/windows.
const MAX_WS_PER_USER = 8;
const userConnections = new Map<string, number>();

/**
 * Largest single WS message accepted. `ws` defaults to 100 MiB, which
 * lets one socket make the server buffer (and Yjs decode) a huge frame.
 * 16 MiB rather than something tighter: a y-websocket client's sync
 * step 2 / first update after a long offline session can carry a large
 * slice of a big layout, and an over-limit frame closes the socket (1009)
 * — the client would reconnect and resend it forever. (The REST snapshot
 * endpoint allows 50 MiB for whole documents.)
 */
export const WS_MAX_PAYLOAD = 16 * 1024 * 1024;

/** Open sockets and the credential/user they authenticated as. */
const openSockets = new Map<
  { close(code?: number, reason?: string): void },
  { userId: string; credential: Credential; layoutId: string }
>();

/** Live connections to one layout right now. */
function connectionsTo(layoutId: string): number {
  let n = 0;
  for (const s of openSockets.values()) if (s.layoutId === layoutId) n += 1;
  return n;
}

/** Live connections per person right now (for the admin abuse view). */
export function liveConnectionsByUser(): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of openSockets.values()) out.set(s.userId, (out.get(s.userId) ?? 0) + 1);
  return out;
}

/** Live connections per layout right now. */
export function liveConnectionsByLayout(): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of openSockets.values()) out.set(s.layoutId, (out.get(s.layoutId) ?? 0) + 1);
  return out;
}

/**
 * True when a handshake may proceed as far as the Origin goes: token
 * (Bearer) handshakes always; cookie handshakes when there's no Origin
 * (a non-browser client — browsers always send one) or it is PUBLIC_URL's.
 */
export function isAllowedWsOrigin(origin: string | undefined, hasBearer: boolean): boolean {
  if (hasBearer || origin === undefined) return true;
  try {
    return new URL(origin).origin === new URL(env.publicUrl).origin;
  } catch {
    return false;
  }
}

/** Live editing right now: open sockets and the layouts they are in. */
export function liveStats(): { connections: number; rooms: number } {
  return { connections: openSockets.size, rooms: docHub.liveRoomCount() };
}

export async function wsRoutes(app: FastifyInstance): Promise<void> {
  await app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD } });
  docHub.startSnapshotWorker();
  // Logout / "revoke all sessions" / user deletion / token revoked:
  // close the affected sockets now rather than when the client next
  // reconnects. 1008 is the code the editor already maps to "not signed
  // in".
  const unsubscribe = onCredentialRevoked((r) => {
    for (const [sock, who] of openSockets) {
      if (isRevokedBy(who.credential, who.userId, r)) {
        try {
          sock.close(1008, ('userId' in r && r.reason) || revokedReason(who.credential));
        } catch {
          /* already closed */
        }
      }
    }
  });
  app.addHook('onClose', async () => {
    docHub.stopSnapshotWorker();
    unsubscribe();
  });

  app.get<{ Params: { id: string } }>(
    '/ws/layout/:id',
    {
      websocket: true,
      config: { apiToken: 'layouts:read' },
      // Runs before the upgrade, so a refused Origin gets a plain 403
      // instead of an accepted-then-closed socket.
      preValidation: async (req, reply) => {
        const origin = req.headers.origin;
        if (!isAllowedWsOrigin(origin, bearerToken(req) !== null)) {
          // Most often a misconfigured PUBLIC_URL (the app reached under
          // another host/port), so say so in the log.
          req.log.warn({ origin, publicUrl: env.publicUrl }, 'ws: refused cross-origin handshake');
          return reply.code(403).send({ error: 'origin_not_allowed' });
        }
      },
    },
    async (socket, req) => {
      const ws = socket;
      // Kept from the first moment (before any await below), so what the
      // client sends while access is checked and the layout loads isn't lost.
      const early = earlyMessages(ws);
      try {
        if (!req.user) {
          ws.close(1008, 'unauthorized');
          return;
        }
        // 4426 = this desktop app is older than the server allows; the
        // desktop stops retrying and asks its user to update.
        if (await blockedDesktopMinimum(req.headers['user-agent'])) {
          ws.close(4426, 'update_required');
          return;
        }
        const layoutId = req.params.id;
        const role = await resolveResourceRole(req.user.id, 'layout', layoutId);
        if (!hasAtLeast(role.role, 'viewer')) {
          // 4404 = our convention for "no such layout". Real WS close
          // codes 4000-4999 are reserved for app use.
          ws.close(4404, 'not_found');
          return;
        }

        const userId = req.user.id;
        // People editing one layout at once (an override on the layout's owner wins).
        const owner = await db
          .select({ ownerUserId: schema.layouts.ownerUserId, ownerOrgId: schema.layouts.ownerOrgId })
          .from(schema.layouts)
          .where(eq(schema.layouts.id, layoutId))
          .get();
        const { values } = await globalLimits();
        const enforce = await limitsEnforced();
        const ownerOv = owner?.ownerOrgId ? overrideFor('org', owner.ownerOrgId) : owner?.ownerUserId ? overrideFor('user', owner.ownerUserId) : null;
        const maxLive = ownerOv?.limits.liveEditorsPerLayout ?? values.liveEditorsPerLayout;
        if (enforce && connectionsTo(layoutId) >= maxLive) {
          ws.close(4429, 'limit_reached');
          return;
        }
        const current = userConnections.get(userId) ?? 0;
        if (current >= MAX_WS_PER_USER) {
          ws.close(4429, 'too_many_connections');
          return;
        }
        userConnections.set(userId, current + 1);

        // role.role is non-null here because hasAtLeast(role.role, 'viewer')
        // succeeded above. Cast for the type system.
        const token = req.apiToken;
        const credential: Credential = token
          ? { kind: 'token', id: token.id }
          : { kind: 'session', id: sessionIdForToken(req.cookies[SESSION_COOKIE] ?? '') };
        // A restricted account (privacy) only looks; its own layouts are already viewer-only (resolveResourceRole).
        // (A suspended person, or a suspended owner's layout, is held to viewer by the handler, which checks it again live.)
        const readOnly = !!req.user.restrictedAt || (token !== null && !hasScope(token.scopes, 'layouts:write'));
        let detach: () => Promise<void>;
        try {
          detach = await attachWsHandlers(ws, layoutId, userId, role.role!, { credential, readOnly, client: req.headers['user-agent'], early });
        } catch (err) {
          const n = (userConnections.get(userId) ?? 1) - 1;
          if (n <= 0) userConnections.delete(userId);
          else userConnections.set(userId, n);
          throw err;
        }

        // A socket can emit 'error' AND 'close' (e.g. an invalid UTF-8
        // text frame), and may already be closed if the client went away
        // while we were hydrating. Run the cleanup exactly once either way:
        // a double detach used to double-decrement the connection count and
        // arm a second idle timer that destroyed the doc under a live client.
        openSockets.set(ws, { userId, credential, layoutId });
        const openedAt = Date.now();
        rollup.count('live_sessions', '', 1, openedAt);
        rollup.peak('live_peak', '', openSockets.size, openedAt);
        touchLayoutOpened(layoutId, openedAt);
        let cleanedUp = false;
        const cleanup = async () => {
          if (cleanedUp) return;
          cleanedUp = true;
          openSockets.delete(ws);
          rollup.count('live_session_ms', '', Date.now() - openedAt);
          rollup.count('live_sessions_ended');
          const n = (userConnections.get(userId) ?? 1) - 1;
          if (n <= 0) userConnections.delete(userId);
          else userConnections.set(userId, n);
          try {
            await detach();
          } catch (err) {
            app.log.error({ err, layoutId }, 'ws detach failed');
          }
        };
        ws.on('close', () => void cleanup());
        ws.on('error', () => void cleanup());
        if (ws.readyState === ws.CLOSING || ws.readyState === ws.CLOSED) {
          void cleanup();
        }
      } catch (err) {
        app.log.error({ err }, 'ws upgrade failed');
        try {
          ws.close(1011, 'internal_error');
        } catch {
          /* socket already closed */
        }
      }
    },
  );
}
