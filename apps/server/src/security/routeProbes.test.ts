// Security probes generated from the route list. Every route the server
// registers needs an entry in ACCESS (who may call it, and the desktop
// token scope it takes); a new route without one fails here, so it can't
// ship unprobed. Each route is then called, in-process, on one seeded
// database (test/probeWorld.ts):
//   - signed out                → 401 (or, for public routes, anything but a 5xx)
//   - as a stranger             → 403/404 for shared, owner, club, admin and moderator routes
//   - as a viewer / plain member → 403/404 for owner / club routes
//   - as a moderator            → 403/404 for admin routes
//   - with a desktop token whose scope the route doesn't take → 401/403
//   - with a body over its limit → 413
//   - with path traversal in each parameter, as a site admin → never 200, never 5xx
//   - as the demo account where it's refused → 403 with a demo error
// and nothing anywhere answers 500.

import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachUser } from '../auth/cookie.js';
import { registerApiRoutes } from '../routes/all.js';
import { closeAll } from '../events/hub.js';
import { concreteUrl, seedProbeWorld, type ProbeWorld } from '../test/probeWorld.js';

/** The server's own default (index.ts); routes may set their own. */
const BODY_LIMIT = 10 * 1024 * 1024;

/**
 * public: anyone; token: anyone holding the link's token (a bad one is a
 * 4xx); user: anyone signed in; shared: anyone the thing is shared with,
 * a viewer too; owner: its owner (or an editor, or a club admin), never a
 * viewer; member: any member of the club; club: the club's admins or
 * managers, never a plain member; mod: moderators and site admins;
 * admin: site admins.
 */
type Access = 'public' | 'token' | 'user' | 'shared' | 'owner' | 'member' | 'club' | 'mod' | 'admin';
type Scope = string | string[] | null;
type Flags = { demo?: true; stream?: true };

const ACCESS: Record<string, [Access, Scope, Flags?]> = {
  'GET /api/version': ['public', 'layouts:read'],
  'GET /api/auth/link': ['public', null],
  'POST /api/auth/link': ['user', null, { demo: true }],
  'DELETE /api/auth/link': ['public', null],
  'POST /api/auth/password/register': ['public', null],
  'POST /api/auth/password/resend-verification': ['public', null],
  'POST /api/auth/password/verify-email/:token': ['token', null],
  'POST /api/auth/password/login': ['public', null],
  'POST /api/auth/password/change': ['user', null, { demo: true }],
  'POST /api/auth/password/forgot': ['public', null],
  'GET /api/auth/password/reset/:token': ['token', null],
  'POST /api/auth/password/reset': ['public', null],
  'POST /api/auth/password/set': ['user', null, { demo: true }],
  'GET /api/auth/me': ['public', null],
  'PATCH /api/auth/me': ['user', null, { demo: true }],
  'GET /api/auth/providers': ['public', null],
  'POST /api/auth/logout': ['public', null],
  'GET /api/auth/sessions': ['user', null, { demo: true }],
  'DELETE /api/auth/sessions/:id': ['user', null, { demo: true }],
  'POST /api/auth/sessions/sign-out-others': ['user', null, { demo: true }],
  'POST /api/auth/device/code': ['public', null],
  'POST /api/auth/device/token': ['public', null],
  'POST /api/auth/device/lookup': ['user', null],
  'POST /api/auth/device/approve': ['user', null, { demo: true }],
  'POST /api/auth/device/deny': ['user', null],
  'POST /api/auth/demo': ['public', null],
  'GET /api/tokens': ['user', null],
  'GET /api/tokens/current': ['user', 'layouts:read'],
  'DELETE /api/tokens/:id': ['owner', null],
  'GET /api/layouts': ['user', 'layouts:read'],
  'GET /api/layouts/:id': ['shared', 'layouts:read'],
  'POST /api/layouts': ['user', 'layouts:create'],
  'PATCH /api/layouts/:id': ['owner', null],
  'DELETE /api/layouts/:id': ['owner', 'layouts:write'],
  'POST /api/layouts/:id/copy': ['shared', null],
  'POST /api/layouts/:id/compare': ['shared', 'layouts:read'],
  'GET /api/layouts/:id/export.bbm': ['shared', 'layouts:read'],
  'GET /api/layouts/:id/export.bld-layout': ['shared', 'layouts:read'],
  'GET /api/layouts/:id/snapshot': ['shared', null],
  'PUT /api/layouts/:id/snapshot': ['owner', null],
  'GET /api/layouts/:id/export.bbm.bld': ['shared', 'layouts:read'],
  'GET /api/layouts/:id/export.bbm.cld': ['shared', 'layouts:read'],
  'GET /api/layouts/:id/export.zip': ['shared', 'layouts:read'],
  'POST /api/layouts/:id/public-share': ['owner', null, { demo: true }],
  'DELETE /api/layouts/:id/public-share': ['owner', null],
  'GET /api/public-layouts/:token': ['token', null],
  'POST /api/layouts/:id/background-image': ['owner', null],
  'GET /api/layouts/:id/background-image': ['shared', null],
  'DELETE /api/layouts/:id/background-image': ['owner', null],
  'GET /api/public-layouts/:token/snapshot': ['token', null],
  'GET /api/parts/catalog': ['public', 'parts:read'],
  'GET /api/layouts/:id/collaborators': ['shared', null],
  'POST /api/layouts/:id/invites': ['owner', null, { demo: true }],
  'DELETE /api/layouts/:id/invites/:inviteId': ['owner', null],
  'PATCH /api/layouts/:id/collaborators/:userId': ['owner', null],
  'DELETE /api/layouts/:id/collaborators/:userId': ['owner', null],
  'GET /api/invites/:token': ['token', null],
  'POST /api/invites/:token': ['owner', null],
  'GET /api/orgs': ['user', 'layouts:read'],
  'POST /api/orgs': ['user', null, { demo: true }],
  'GET /api/orgs/:slug': ['member', null],
  'PATCH /api/orgs/:slug': ['club', null],
  'DELETE /api/orgs/:slug': ['club', null],
  'PUT /api/orgs/:slug/logo': ['club', null, { demo: true }],
  'DELETE /api/orgs/:slug/logo': ['club', null],
  'GET /api/orgs/:slug/logo': ['user', 'layouts:read'],
  'POST /api/orgs/:slug/hand-over': ['club', null],
  'GET /api/orgs/:slug/members': ['member', 'layouts:read'],
  'POST /api/orgs/:slug/invites': ['club', null, { demo: true }],
  'GET /api/orgs/:slug/user-search': ['club', null],
  'DELETE /api/orgs/:slug/invites/:inviteId': ['club', null],
  'POST /api/orgs/:slug/invites/:inviteId/resend': ['club', null],
  'PATCH /api/orgs/:slug/members/:userId': ['club', null],
  'GET /api/orgs/:slug/roles': ['member', null],
  'POST /api/orgs/:slug/roles': ['club', null],
  'PATCH /api/orgs/:slug/roles/:roleId': ['club', null],
  'DELETE /api/orgs/:slug/roles/:roleId': ['club', null],
  'DELETE /api/orgs/:slug/members/:userId': ['club', null],
  'GET /api/orgs/:slug/layouts': ['member', null],
  'GET /api/orgs/:slug/part-libraries': ['member', null],
  'PUT /api/orgs/:slug/part-libraries/:libraryId': ['club', null],
  'DELETE /api/orgs/:slug/part-libraries/:libraryId': ['club', null],
  'GET /api/org-invites/:token': ['token', null],
  'POST /api/org-invites/:token': ['owner', null, { demo: true }],
  'GET /api/club-directory': ['user', null],
  'GET /api/orgs/:slug/summary': ['user', null],
  'POST /api/orgs/:slug/join': ['user', null, { demo: true }],
  'DELETE /api/orgs/:slug/join': ['user', null],
  'GET /api/orgs/:slug/join-requests': ['club', null],
  'POST /api/orgs/:slug/join-requests/:id/approve': ['club', null],
  'POST /api/orgs/:slug/join-requests/:id/decline': ['club', null],
  'GET /api/join-requests/count': ['user', null],
  'POST /api/layouts/:id/transfer': ['owner', null, { demo: true }],
  'GET /api/transfers/:token': ['token', null],
  'POST /api/transfers/:token': ['owner', null],
  'DELETE /api/layouts/:id/transfer/:transferId': ['owner', null],
  'GET /api/custom-parts': ['user', 'parts:read'],
  'GET /api/custom-parts/:id': ['shared', null],
  'GET /api/custom-parts/:id/sprite': ['shared', 'parts:read'],
  'GET /api/custom-parts/:id/xml': ['shared', 'parts:read'],
  'POST /api/custom-parts': ['user', 'parts:write', { demo: true }],
  'PUT /api/custom-parts/:id': ['owner', 'parts:write', { demo: true }],
  'DELETE /api/custom-parts/:id': ['owner', 'parts:write'],
  'PATCH /api/custom-parts/:id/listing': ['owner', 'parts:write', { demo: true }],
  'GET /api/custom-parts/:id/collaborators': ['shared', null],
  'POST /api/custom-parts/:id/invites': ['owner', null, { demo: true }],
  'DELETE /api/custom-parts/:id/invites/:inviteId': ['owner', null],
  'GET /api/part-invites/:token': ['token', null],
  'POST /api/part-invites/:token': ['owner', null],
  'PATCH /api/custom-parts/:id/collaborators/:userId': ['owner', null],
  'DELETE /api/custom-parts/:id/collaborators/:userId': ['owner', null],
  'GET /api/modules': ['user', 'layouts:read'],
  'GET /api/modules/:id': ['shared', 'layouts:read'],
  'POST /api/modules': ['user', 'layouts:write'],
  'POST /api/modules/:id/copy': ['shared', 'layouts:write'],
  'PATCH /api/modules/:id': ['owner', 'layouts:write'],
  'DELETE /api/modules/:id': ['owner', 'layouts:write'],
  'GET /api/modules/:id/snapshot': ['shared', 'layouts:read'],
  'PUT /api/modules/:id/snapshot': ['owner', 'layouts:write'],
  'PUT /api/modules/:id/thumbnail': ['owner', 'layouts:write'],
  'GET /api/modules/:id/thumbnail': ['shared', 'layouts:read'],
  'GET /api/modules/:id/versions': ['shared', 'layouts:read'],
  'GET /api/modules/:id/versions/:n/snapshot': ['shared', 'layouts:read'],
  'GET /api/modules/:id/versions/:n/thumbnail': ['shared', 'layouts:read'],
  'POST /api/modules/:id/versions/:n/restore': ['owner', null],
  'GET /api/modules/:id/collaborators': ['shared', null],
  'POST /api/modules/:id/invites': ['owner', null, { demo: true }],
  'DELETE /api/modules/:id/invites/:inviteId': ['owner', null],
  'GET /api/module-invites/:token': ['token', null],
  'POST /api/module-invites/:token': ['owner', null],
  'DELETE /api/modules/:id/collaborators/:userId': ['owner', null],
  'GET /api/catalog/settings': ['public', 'layouts:read'],
  'GET /api/catalog/items': ['public', 'layouts:read'],
  'GET /api/catalog/items/:id': ['public', 'layouts:read'],
  'GET /api/catalog/items/:id/preview': ['public', 'layouts:read'],
  'POST /api/catalog/submissions': ['user', ['layouts:write', 'parts:write']],
  'GET /api/catalog/mine': ['user', 'layouts:read'],
  'POST /api/catalog/items/:id/withdraw': ['owner', null],
  'POST /api/catalog/items/:id/add': ['user', ['layouts:write', 'parts:write']],
  'GET /api/catalog/copies': ['user', 'layouts:read'],
  'POST /api/catalog/copies/:copyId/update': ['owner', null],
  'GET /api/moderation/items': ['mod', null],
  'GET /api/moderation/catalog': ['mod', null],
  'GET /api/moderation/covers': ['mod', null],
  'GET /api/moderation/counts': ['mod', null],
  'POST /api/moderation/bulk': ['mod', null],
  'POST /api/moderation/versions/:versionId/approve': ['mod', null],
  'POST /api/moderation/versions/:versionId/decline': ['mod', null],
  'POST /api/moderation/items/:id/unpublish': ['mod', null],
  'POST /api/moderation/items/:id/restore': ['mod', null],
  'GET /api/catalog/collections': ['public', 'layouts:read'],
  'GET /api/catalog/collections/mine': ['user', null],
  'GET /api/catalog/collections/clubs': ['user', null],
  'GET /api/catalog/collections/:id': ['public', 'layouts:read'],
  'POST /api/catalog/collections': ['user', null, { demo: true }],
  'PATCH /api/catalog/collections/:id': ['owner', null, { demo: true }],
  'POST /api/catalog/collections/:id/items': ['owner', null],
  'POST /api/catalog/collections/:id/withdraw': ['owner', null],
  'DELETE /api/catalog/collections/:id': ['owner', null],
  'POST /api/catalog/collections/:id/dismiss-note': ['owner', null],
  'POST /api/catalog/collections/:id/add': ['owner', ['layouts:write', 'parts:write']],
  'PUT /api/catalog/collections/:id/cover': ['owner', null],
  'DELETE /api/catalog/collections/:id/cover': ['owner', null, { demo: true }],
  'GET /api/catalog/collections/:id/cover': ['public', 'layouts:read'],
  'GET /api/moderation/collections': ['mod', null],
  'POST /api/moderation/collections/:id/approve': ['mod', null],
  'POST /api/moderation/collections/:id/decline': ['mod', null],
  'POST /api/moderation/collections/:id/unpublish': ['mod', null],
  'POST /api/moderation/collections/:id/restore': ['mod', null],
  'POST /api/moderation/collections/:id/remove': ['mod', null],
  'GET /api/moderation/collections/list': ['mod', null],
  'POST /api/moderation/collections/bulk': ['mod', null],
  'POST /api/moderation/collections/:id/feature': ['mod', null],
  'PUT /api/catalog/items/:id/cover': ['owner', null],
  'DELETE /api/catalog/items/:id/cover': ['owner', null],
  'GET /api/catalog/items/:id/cover': ['public', 'layouts:read'],
  'POST /api/moderation/items/:id/cover/approve': ['mod', null],
  'POST /api/moderation/items/:id/cover/decline': ['mod', null],
  'GET /api/catalog/items/:id/snapshot': ['public', 'layouts:read'],
  'GET /api/catalog/items/:id/download': ['public', 'layouts:read'],
  'GET /api/catalog/items/:id/venue': ['public', 'layouts:read'],
  'POST /api/moderation/clubs/:slug/trust': ['mod', null],
  'GET /api/moderation/clubs': ['mod', null],
  'GET /api/orgs/:slug/review': ['club', null],
  'POST /api/orgs/:slug/review/versions/:id/approve': ['club', null],
  'POST /api/orgs/:slug/review/versions/:id/decline': ['club', null],
  'POST /api/orgs/:slug/review/items/:id/cover/approve': ['club', null],
  'POST /api/orgs/:slug/review/items/:id/cover/decline': ['club', null],
  'POST /api/orgs/:slug/review/items/:id/unpublish': ['club', null],
  'POST /api/orgs/:slug/review/collections/:id/approve': ['club', null],
  'POST /api/orgs/:slug/review/collections/:id/decline': ['club', null],
  'POST /api/orgs/:slug/review/collections/:id/unpublish': ['club', null],
  'POST /api/modules/:id/transfer': ['owner', null, { demo: true }],
  'GET /api/venues': ['user', 'venues:read'],
  'GET /api/venues/:id': ['owner', 'venues:read'],
  'POST /api/venues': ['user', 'venues:write'],
  'PATCH /api/venues/:id': ['owner', 'venues:write'],
  'DELETE /api/venues/:id': ['owner', 'venues:write'],
  'POST /api/venues/:id/copy': ['owner', 'venues:write'],
  'GET /api/admin/deleted-layouts': ['admin', null],
  'POST /api/venues/:id/move': ['owner', 'venues:write'],
  'GET /api/me/preferences': ['user', ['layouts:read', 'account:prefs']],
  'PUT /api/me/preferences': ['user', 'account:prefs'],
  'GET /api/parts/manifest': ['public', 'parts:read'],
  'GET /api/parts/manifest/libraries/:slug': ['public', 'parts:read'],
  'GET /api/layouts/:id/audit': ['shared', null],
  'GET /api/orgs/:slug/audit': ['club', null],
  'GET /api/audit': ['user', null],
  'GET /api/admin/users': ['admin', null],
  'GET /api/admin/users/:id': ['admin', null],
  'PATCH /api/admin/users/:id': ['admin', null],
  'DELETE /api/admin/users/:id': ['admin', null],
  'POST /api/admin/users/:id/sessions/revoke-all': ['admin', null],
  'GET /api/admin/orgs': ['admin', null],
  'GET /api/admin/orgs/:id': ['admin', null],
  'DELETE /api/admin/orgs/:id': ['admin', null],
  'GET /api/admin/layouts': ['admin', null],
  'DELETE /api/admin/layouts/:id': ['admin', null],
  'GET /api/admin/global-parts': ['admin', null],
  'POST /api/admin/global-parts': ['admin', null],
  'DELETE /api/admin/global-parts/:id': ['admin', null],
  'GET /api/admin/audit': ['admin', null],
  'GET /api/admin/part-libraries': ['admin', null],
  'POST /api/admin/part-libraries': ['admin', null],
  'GET /api/admin/part-libraries/search': ['admin', null],
  'POST /api/admin/part-libraries/install-base': ['admin', null],
  'POST /api/admin/part-libraries/download': ['admin', null],
  'PATCH /api/admin/part-libraries/:id': ['admin', null],
  'POST /api/admin/part-libraries/:id/update': ['admin', null],
  'DELETE /api/admin/part-libraries/:id': ['admin', null],
  'POST /api/admin/reload-parts': ['admin', null],
  'GET /api/admin/stats': ['admin', null],
  'GET /api/admin/settings': ['admin', null],
  'PATCH /api/admin/settings': ['admin', null],
  'POST /api/admin/demo/reset': ['admin', null],
  'GET /api/admin/stats/series': ['admin', null],
  'GET /api/admin/insights/usage': ['admin', null],
  'GET /api/admin/insights/content': ['admin', null],
  'GET /api/admin/insights/people': ['admin', null],
  'GET /api/admin/insights/health': ['admin', null],
  'GET /api/admin/insights/alerts': ['admin', null],
  'POST /api/metrics/client': ['public', null],
  'GET /api/admin/limits': ['admin', null],
  'PATCH /api/admin/limits': ['admin', null],
  'GET /api/admin/abuse/users': ['admin', null],
  'GET /api/admin/abuse/clubs': ['admin', null],
  'GET /api/admin/users/:id/usage': ['admin', null],
  'GET /api/admin/orgs/:id/usage': ['admin', null],
  'PUT /api/admin/users/:id/limits': ['admin', null],
  'PUT /api/admin/orgs/:id/limits': ['admin', null],
  'GET /ws/layout/:id': ['owner', 'layouts:read', { stream: true }],
  'GET /api/events': ['user', ['layouts:read', 'layouts:write', 'layouts:create', 'parts:read', 'parts:write', 'venues:read', 'venues:write', 'account:prefs'], { stream: true }],
  'POST /api/admin/warnings': ['mod', null],
  'GET /api/admin/warnings': ['mod', null],
  'POST /api/orgs/:slug/warnings': ['club', null],
  'GET /api/orgs/:slug/warnings': ['club', null],
  'GET /api/notices': ['user', 'layouts:read'],
  'POST /api/notices/acknowledge-all': ['user', 'layouts:read'],
  'POST /api/notices/:id/acknowledge': ['owner', 'layouts:read'],
  'POST /api/layouts/:id/take-back': ['owner', 'layouts:write', { demo: true }],
  'POST /api/layouts/:id/give-back': ['owner', 'layouts:write', { demo: true }],
  'POST /api/modules/:id/take-back': ['owner', 'layouts:write', { demo: true }],
  'POST /api/modules/:id/give-back': ['owner', 'layouts:write', { demo: true }],
  'POST /api/custom-parts/:id/take-back': ['owner', 'parts:write', { demo: true }],
  'POST /api/custom-parts/:id/give-back': ['owner', 'parts:write', { demo: true }],
  'POST /api/venues/:id/take-back': ['owner', 'venues:write', { demo: true }],
  'POST /api/venues/:id/give-back': ['owner', 'venues:write', { demo: true }],
  'POST /api/custom-parts/:id/move': ['owner', 'parts:write', { demo: true }],
  'GET /api/custom-parts/:id/move-plan': ['owner', null],
  'GET /api/custom-parts/:id/copy-plan': ['shared', null],
  'POST /api/custom-parts/:id/copy': ['shared', 'parts:write', { demo: true }],
  'GET /api/me/privacy/exports': ['user', null],
  'GET /api/me/org-invites': ['user', null],
  'POST /api/me/privacy/exports': ['user', null, { demo: true }],
  'GET /api/me/deletion': ['user', null],
  'POST /api/me/deletion': ['user', null, { demo: true }],
  'GET /api/privacy/exports/:id/download': ['owner', null],
  'GET /api/admin/privacy/requests': ['admin', null],
  'GET /api/admin/privacy/summary': ['admin', null],
  'POST /api/admin/privacy/requests': ['admin', null],
  'GET /api/admin/privacy/requests/:id': ['admin', null],
  'PATCH /api/admin/privacy/requests/:id': ['admin', null],
  'POST /api/admin/privacy/requests/:id/export': ['admin', null],
  'POST /api/admin/privacy/requests/:id/erase': ['admin', null],
  'POST /api/admin/privacy/requests/:id/restrict': ['admin', null],
  'GET /api/privacy': ['public', null],
  'GET /api/orgs/deleting': ['user', null],
  'GET /api/orgs/:slug/deletion': ['club', null],
  'GET /api/orgs/:slug/exports': ['club', null],
  'POST /api/orgs/:slug/exports': ['club', null],
  'POST /api/orgs/:slug/move-all': ['club', null],
  'POST /api/orgs/:slug/restore': ['club', null],
  'POST /api/admin/orgs/:id/restore': ['admin', null],
  'POST /api/admin/orgs/:id/erase': ['admin', null],
};

/** Bodies that get a probe past validation to the access check. */
const BODIES: Record<string, (w: ProbeWorld) => unknown> = {
  'POST /api/catalog/collections/:id/items': (w) => ({ itemId: w.ids.publicItem }),
};

interface Route {
  key: string;
  method: string;
  url: string;
  bodyLimit: number;
  scope: Scope;
}

// A bare '..' is resolved by URL parsing into another route, so only encoded forms reach a parameter.
const TRAVERSALS = ['..%2F..%2Fetc%2Fpasswd', '%2e%2e%2f%2e%2e%2f', '....%2F%2F', '..%5C..%5Cwindows', '%00', 'a%2F..%2F..%2Fb'];

describe('security probes for every route', () => {
  let app: FastifyInstance;
  let w: ProbeWorld;
  const routes: Route[] = [];
  const fives: string[] = [];

  async function call(route: Route, who: { cookie?: string; bearer?: string }, opts: Partial<InjectOptions> & { url?: string } = {}) {
    const headers: Record<string, string> = { ...((opts.headers as Record<string, string>) ?? {}) };
    if (who.cookie) headers.cookie = who.cookie;
    if (who.bearer) headers.authorization = `Bearer ${who.bearer}`;
    const sendsBody = route.method !== 'GET' && route.method !== 'DELETE';
    const body = BODIES[route.key]?.(w) ?? {};
    const res = await app.inject({
      method: route.method as 'GET',
      url: opts.url ?? concreteUrl(route.url, w),
      headers,
      ...(sendsBody && opts.payload === undefined ? { payload: body as Record<string, unknown> } : {}),
      ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
    } as InjectOptions & { method: 'GET' });
    if (res.statusCode >= 500) fives.push(`${route.key} (${opts.url ?? 'seeded ids'}, ${who.cookie ? 'signed in' : who.bearer ? 'token' : 'signed out'}) → ${res.statusCode} ${res.body.slice(0, 120)}`);
    return res;
  }

  beforeAll(async () => {
    app = Fastify({ bodyLimit: BODY_LIMIT });
    await app.register(cookie);
    await app.register(fastifyMultipart);
    app.addHook('preHandler', attachUser);
    app.addHook('onRoute', (r) => {
      for (const m of Array.isArray(r.method) ? r.method : [r.method]) {
        if (m === 'HEAD') continue;
        const key = `${m} ${r.url}`;
        routes.push({ key, method: m, url: r.url, bodyLimit: r.bodyLimit ?? BODY_LIMIT, scope: ((r.config as { apiToken?: Scope } | undefined)?.apiToken ?? null) as Scope });
      }
    });
    await registerApiRoutes(app);
    await app.ready();
    w = await seedProbeWorld(app);
    // Signing out (and the like) last, so the probes before keep their sessions.
    routes.sort((a, b) => Number(a.url.includes('logout')) - Number(b.url.includes('logout')));
  });
  afterAll(async () => {
    closeAll();
    await app.close();
  });

  // Routes without an entry fail the first test only; the probes skip them.
  const known = () => routes.filter((r) => r.key in ACCESS);
  const signedIn = (r: Route) => !ACCESS[r.key]?.[2]?.stream;
  const byAccess = (...a: Access[]) => known().filter((r) => a.includes(ACCESS[r.key]![0]));

  it('every route has an entry, and every entry a route (a new route needs its probe)', () => {
    expect(routes.length).toBeGreaterThan(200);
    expect(routes.map((r) => r.key).filter((k) => !(k in ACCESS))).toEqual([]);
    expect(Object.keys(ACCESS).filter((k) => !routes.some((r) => r.key === k))).toEqual([]);
  });

  it('each entry names the desktop token scope the route takes', () => {
    const wrong = known().filter((r) => JSON.stringify(ACCESS[r.key]![1]) !== JSON.stringify(r.scope)).map((r) => `${r.key}: table ${JSON.stringify(ACCESS[r.key]![1])}, route ${JSON.stringify(r.scope)}`);
    expect(wrong).toEqual([]);
  });

  it('signed out: 401 unless public', async () => {
    const wrong: string[] = [];
    for (const r of known()) {
      const res = await call(r, {});
      const access = ACCESS[r.key]![0];
      if (access === 'public') {
        if (res.statusCode === 401 || res.statusCode === 403) wrong.push(`${r.key}: public but ${res.statusCode}`);
      } else if (access === 'token') {
        if (![400, 401, 403, 404, 410].includes(res.statusCode)) wrong.push(`${r.key}: a bad token gave ${res.statusCode}`);
      } else if (ACCESS[r.key]![2]?.stream && r.url.startsWith('/ws/')) {
        // A plain GET (no upgrade) never reaches the socket handler.
        if (![401, 404].includes(res.statusCode)) wrong.push(`${r.key}: ${res.statusCode}`);
      } else if (res.statusCode !== 401) {
        wrong.push(`${r.key}: ${res.statusCode}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('signed out, no link preview or public route returns a full email address', async () => {
    const i = w.ids;
    // The seeded links (test/probeWorld.ts), so each preview answers with what it shows.
    const real: Record<string, string> = {
      'GET /api/invites/:token': `inv-${i.invite}`,
      'GET /api/module-invites/:token': `minv-${i.moduleInvite}`,
      'GET /api/part-invites/:token': `pinv-${i.partInvite}`,
      'GET /api/org-invites/:token': `oinv-${i.orgInvite}`,
      'GET /api/transfers/:token': `tr-${i.transfer}`,
    };
    // A masked address ("z…@example.com") has no name before the @.
    const FULL_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
    const wrong: string[] = [];
    const answered: string[] = [];
    for (const r of byAccess('public', 'token').filter((r) => r.method === 'GET' && signedIn(r))) {
      const token = real[r.key];
      const res = await call(r, {}, token ? { url: r.url.replace(':token', token) } : {});
      if (token && res.statusCode === 200) answered.push(r.key);
      const found = res.body.match(FULL_EMAIL);
      if (found) wrong.push(`${r.key}: ${found.join(', ')}`);
    }
    expect(wrong).toEqual([]);
    expect(answered.sort()).toEqual(Object.keys(real).sort());
  });

  it('a stranger is refused the owner’s, the club’s, the moderators’ and the admins’ routes', async () => {
    const wrong: string[] = [];
    for (const r of byAccess('shared', 'owner', 'member', 'club', 'mod', 'admin').filter(signedIn)) {
      const res = await call(r, { cookie: w.stranger.cookie });
      if (![403, 404].includes(res.statusCode)) wrong.push(`${r.key}: ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  });

  it('a viewer is refused what only the owner may do; a plain member what only the club’s admins may', async () => {
    const wrong: string[] = [];
    for (const r of byAccess('owner', 'club').filter(signedIn)) {
      const who = ACCESS[r.key]![0] === 'club' ? w.member : /^\/api\/(layouts|modules|custom-parts)\/:id/.test(r.url) ? w.viewer : null;
      if (!who) continue; // venues and collections have no viewers
      const res = await call(r, { cookie: who.cookie });
      if (![403, 404].includes(res.statusCode)) wrong.push(`${r.key}: ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  });

  it('a moderator is refused the admins’ routes', async () => {
    const wrong: string[] = [];
    for (const r of byAccess('admin')) {
      const res = await call(r, { cookie: w.mod.cookie });
      if (![403, 404].includes(res.statusCode)) wrong.push(`${r.key}: ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  });

  it('a desktop token is refused where its scope doesn’t reach', async () => {
    // The stranger's token has only account:prefs.
    const wrong: string[] = [];
    for (const r of known().filter(signedIn)) {
      const scopes = r.scope === null ? [] : Array.isArray(r.scope) ? r.scope : [r.scope];
      if (scopes.includes('account:prefs')) continue;
      const access = ACCESS[r.key]![0];
      const res = await call(r, { bearer: w.prefsOnlyToken });
      if (access === 'public' || access === 'token') {
        if (res.statusCode >= 200 && res.statusCode < 300 && r.method !== 'GET') wrong.push(`${r.key}: changed something with a prefs-only token (${res.statusCode})`);
        continue;
      }
      if (![401, 403].includes(res.statusCode)) wrong.push(`${r.key}: ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  });

  it('a body over the route’s limit is refused with 413', async () => {
    const wrong: string[] = [];
    const big = new Map<number, Buffer>();
    for (const r of known().filter((r) => r.method === 'POST' || r.method === 'PUT' || r.method === 'PATCH')) {
      if (!big.has(r.bodyLimit)) big.set(r.bodyLimit, Buffer.alloc(r.bodyLimit + 1, 0x20));
      const res = await call(r, { cookie: w.root.cookie }, { payload: big.get(r.bodyLimit)!, headers: { 'content-type': 'application/json' } });
      if (res.statusCode !== 413) wrong.push(`${r.key}: ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  });

  it('path traversal in any parameter, even as a site admin, is never a 200 or a 5xx', async () => {
    const wrong: string[] = [];
    for (const r of known().filter((r) => r.url.includes(':'))) {
      for (const t of TRAVERSALS) {
        const url = concreteUrl(r.url, w, t);
        const res = await call(r, signedIn(r) ? { cookie: w.root.cookie } : {}, { url });
        if (res.statusCode === 200 || res.statusCode === 201 || res.statusCode === 204) wrong.push(`${r.key} at ${url}: ${res.statusCode}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the demo account is refused, with a demo error, where it may not go', async () => {
    const wrong: string[] = [];
    for (const r of known().filter((r) => ACCESS[r.key]![2]?.demo)) {
      const res = await call(r, { cookie: w.demoCookie });
      if (res.statusCode !== 403 || !/demo/.test(String((res.json() as { error?: string }).error))) wrong.push(`${r.key}: ${res.statusCode} ${res.body.slice(0, 80)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('nothing answered 500', () => {
    expect(fives).toEqual([]);
  });
});
