import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';
import { SESSION_COOKIE, validateSession } from './session.js';
import { hasScope, validateApiToken, type ApiScope } from './apiTokens.js';
import type { User } from '../db/schema.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    /**
     * Set when the request authenticated with an API token (Bearer)
     * rather than the session cookie. Routes that let a token write
     * (only the realtime WebSocket today) check `scopes` themselves.
     */
    apiToken: { id: string; scopes: ApiScope[] } | null;
  }
  interface FastifyContextConfig {
    /**
     * Opt this route in to `Authorization: Bearer bld_pat_…` auth, with
     * the scope the token needs. Routes without it reject every
     * token-authenticated request (403), so the allow-list is exactly
     * the set of routes carrying this config. A list means any one of
     * those scopes is enough.
     */
    apiToken?: ApiScope | readonly ApiScope[];
  }
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** The raw `Authorization: Bearer …` credential, or null when absent. */
export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const m = /^Bearer[ \t]+(\S+)\s*$/i.exec(h);
  return m ? m[1]! : null;
}

/** A GET or HEAD for a parts-library file, served to everyone. */
export function isPublicPartFile(req: Pick<FastifyRequest, 'method' | 'url'>): boolean {
  return (req.method === 'GET' || req.method === 'HEAD') && req.url.startsWith('/parts/');
}

/**
 * Populate `req.user` from the session cookie, or — only on routes that
 * opt in via `config.apiToken` — from a Bearer API token. A request that
 * carries a Bearer token never falls back to its cookie: token clients
 * get exactly the token's powers. Tokens are only read from the header,
 * never from the query string (URLs end up in logs and proxies).
 */
export async function attachUser(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  req.apiToken = null;
  const bearer = bearerToken(req);
  if (bearer !== null) {
    req.user = null;
    const needed = req.routeOptions.config?.apiToken;
    // Part files are public: a desktop that sends its token with them (as
    // 1.2.0 does for every request to its server) gets them like anyone.
    if (!needed && isPublicPartFile(req)) return;
    if (!needed) return reply.code(403).send({ error: 'token_not_allowed' });
    const result = await validateApiToken(bearer);
    if (!result) {
      reply.header('WWW-Authenticate', 'Bearer error="invalid_token"');
      return reply.code(401).send({ error: 'invalid_token' });
    }
    const anyOf: readonly ApiScope[] = typeof needed === 'string' ? [needed] : needed;
    if (!anyOf.some((s) => hasScope(result.scopes, s))) {
      reply.header('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${anyOf.join(' ')}"`);
      return reply.code(403).send({ error: 'insufficient_scope' });
    }
    // An account waiting to be deleted: the desktop says why, instead of failing.
    if (result.user.deletionDueAt) {
      return reply.code(403).send({
        error: 'account_pending_deletion',
        deletionDueAt: result.user.deletionDueAt.getTime(),
        message: `This account is being deleted on ${result.user.deletionDueAt.toUTCString()}. To keep it, sign in on the website before then.`,
      });
    }
    req.user = withoutDemoPowers(result.user);
    req.apiToken = { id: result.token.id, scopes: result.scopes };
    return refuseIfRestricted(req, reply);
  }

  const token = req.cookies[SESSION_COOKIE];
  if (!token) {
    req.user = null;
    return;
  }
  const result = await validateSession(token, req.headers['user-agent']);
  if (!result) {
    req.user = null;
    clearSessionCookie(reply);
    return;
  }
  if (result.refreshed) setSessionCookie(reply, token, result.session.expiresAt);
  req.user = withoutDemoPowers(result.user);
  return refuseIfRestricted(req, reply);
}

/**
 * What a restricted account may still change: signing in and out, the
 * client beacon, reading a notice, and asking for (or deleting) its data:
 * restriction stops other changes, not the person's own privacy rights.
 */
function allowedWhileRestricted(url: string): boolean {
  return (
    url.startsWith('/api/auth/') ||
    url.startsWith('/api/metrics/') ||
    url.startsWith('/api/notices/') ||
    url.startsWith('/api/me/privacy/') ||
    url.startsWith('/api/me/deletion')
  );
}

/**
 * A restricted account (Admin › Privacy requests › Restrict) is read only,
 * whatever the usage-limit switch says: every change is refused with a
 * reason the web and the desktop show.
 */
/**
 * Anyone can sign in as the demo account, so it never acts as a site admin
 * or moderator, even if a database edit gave it the flags.
 */
export function withoutDemoPowers(user: User): User {
  if (!user.isDemoAccount || (!user.isGlobalAdmin && !user.isModerator)) return user;
  return { ...user, isGlobalAdmin: false, isModerator: false };
}

function refuseIfRestricted(req: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
  const u = req.user;
  if (!u?.restrictedAt) return undefined;
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return undefined;
  if (allowedWhileRestricted(req.url)) return undefined;
  return reply.code(403).send({
    error: 'account_restricted',
    message: 'Your account is on hold (read only) while a privacy request is looked at. You can still see and download your things. Ask the site admin.',
  });
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) {
    const err = new Error('unauthorized');
    (err as Error & { statusCode?: number }).statusCode = 401;
    throw err;
  }
  return req.user;
}

/**
 * Stricter variant for the platform-admin endpoints. Throws 401 if no
 * session, 403 when the session belongs to a non-global-admin user.
 *
 * Every endpoint mounted at `/api/admin/*` must call this — the
 * boundary is per-route rather than per-prefix because Fastify's
 * preHandler hooks are global, and we want the permission check to
 * sit next to the route's own logic for clarity.
 */
export function requireGlobalAdmin(req: FastifyRequest): User {
  const user = requireUser(req);
  if (!user.isGlobalAdmin) {
    const err = new Error('forbidden');
    (err as Error & { statusCode?: number }).statusCode = 403;
    throw err;
  }
  return user;
}
