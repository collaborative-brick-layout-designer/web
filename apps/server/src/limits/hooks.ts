// Request-time limits: per-person and per-token request rates, the
// read-only state of a suspended account, and the per-person request
// counters the abuse view reads. Registered right after attachUser.

import type { FastifyInstance } from 'fastify';
import { globalLimits, limitsEnforced, overrideFor } from './limits.js';
import { usage } from '../metrics/usage.js';

const WINDOW_MS = 60_000;
const windows = new Map<string, { start: number; n: number }>();

/** Forget the rate windows (tests). */
export function resetRateWindows(): void {
  windows.clear();
}

/** Count one request against `key`; true when it is over `max` this minute. */
export function overRate(key: string, max: number, now: number = Date.now()): boolean {
  let w = windows.get(key);
  if (!w || now - w.start >= WINDOW_MS) {
    w = { start: now, n: 0 };
    windows.set(key, w);
    if (windows.size > 100_000) {
      for (const [k, v] of windows) if (now - v.start >= WINDOW_MS) windows.delete(k);
    }
  }
  w.n += 1;
  return w.n > max;
}

/**
 * Part pictures and files, and layout background pictures: a big custom
 * library (or the desktop syncing one) fetches hundreds at once, so these
 * GETs are counted but never rate-limited.
 */
const ASSET_ROUTES = new Set(['/api/custom-parts/:id/sprite', '/api/custom-parts/:id/xml', '/api/layouts/:id/background-image']);

/** Routes a suspended person may still POST to: signing in and out, and the client beacon. */
function allowedWhileSuspended(url: string): boolean {
  return url.startsWith('/api/auth/') || url.startsWith('/api/metrics/');
}

export function registerLimitHooks(app: FastifyInstance): void {
  app.addHook('preHandler', async (req, reply) => {
    const user = req.user;
    if (!user) return;
    const url = req.url;
    if (!url.startsWith('/api/') && !url.startsWith('/ws/')) return;
    const now = Date.now();
    usage.count('user', user.id, 'requests', 1, now);
    const ov = overrideFor('user', user.id, now);
    // Read-only holds whether or not usage limits are enforced: an admin
    // who marks someone read-only expects it to stick.
    if (ov.suspended && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE' && req.method !== 'OPTIONS' && !allowedWhileSuspended(url)) {
      return reply.code(403).send({
        error: 'suspended',
        message: 'Your account is read-only for now. Ask the site admin why.',
      });
    }
    if (!(await limitsEnforced(now))) return; // counted, never rate-limited

    const { values } = await globalLimits(now);
    const token = req.apiToken;
    const max = token
      ? (ov.limits.requestsPerMinuteToken ?? values.requestsPerMinuteToken)
      : (ov.limits.requestsPerMinuteUser ?? values.requestsPerMinuteUser);
    const asset = req.method === 'GET' && ASSET_ROUTES.has(req.routeOptions?.url ?? '');
    if (!asset && overRate(token ? `t:${token.id}` : `u:${user.id}`, max, now)) {
      reply.header('retry-after', '60');
      return reply.code(429).send({
        error: 'rate_limited',
        limit: token ? 'requestsPerMinuteToken' : 'requestsPerMinuteUser',
        max,
        message: 'Too many requests at once. Please wait a minute and try again.',
      });
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!req.user) return;
    if (reply.statusCode === 403 || reply.statusCode === 429) usage.count('user', req.user.id, 'refused');
  });
}
