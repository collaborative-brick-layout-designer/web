// Which live hint each changing API route sends. One table, so "does
// every change reach the people who see it" is checked in one place:
// routeHints.test.ts fails when a POST/PUT/PATCH/DELETE route is in
// neither ROUTE_HINTS nor NO_HINT.
//
// Each entry may read what it needs *before* the route runs (`before`:
// the owner of a thing about to be deleted or moved, the members of a
// club about to lose one), and builds the hints once the route answered
// with a 2xx (`after`, with the route's JSON reply). Hints are published
// after the reply is sent and never fail a request.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import type { Hint, HintOwner } from './hub.js';
import { orgIdBySlug, ownerOfResource, publish, staffIds, type Reach } from './audience.js';
import { clubRunners, recipientsOf } from '../routes/warnings.js';

type ResourceKind = 'layout' | 'module' | 'venue' | 'custom-part';

export interface HintCtx {
  req: FastifyRequest;
  params: Record<string, string>;
  body: Record<string, unknown>;
  /** The route's JSON reply (2xx only), or null. */
  reply: Record<string, unknown> | null;
  userId: string | null;
  /** What `before` stored. */
  before: Record<string, unknown>;
}

export interface HintSpec {
  before?: (ctx: HintCtx) => Promise<void>;
  after: (ctx: HintCtx) => Promise<Array<{ hint: Hint; reach?: Reach }>>;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function action(req: FastifyRequest): string {
  const url = req.routeOptions.url ?? '';
  const last = url.split('/').filter((s) => s && !s.startsWith(':')).pop() ?? '';
  const verb = req.method === 'POST' ? 'create' : req.method === 'DELETE' ? 'delete' : 'update';
  return last && !['layouts', 'modules', 'venues', 'custom-parts', 'orgs'].includes(last) ? `${verb}:${last}` : verb;
}

function sameOwner(a?: HintOwner, b?: HintOwner): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

/**
 * A layout, module, venue or custom part. The hint goes to whoever owned
 * it before the change and whoever owns it after (a move, a transfer, a
 * copy into a club), plus `extraUsers` (someone just removed from it).
 * `idFrom` says where the thing's id is: a route param, or the reply
 * (a create or copy answers with the new id).
 */
function resource(
  kind: ResourceKind,
  idFrom: { param?: string; reply?: string } = { param: 'id' },
  extraUsers: (ctx: HintCtx) => (string | null)[] = () => [],
): HintSpec {
  return {
    before: async (ctx) => {
      const id = idFrom.param ? ctx.params[idFrom.param] : null;
      if (!id) return;
      const was = await ownerOfResource(kind, id);
      ctx.before.owner = was?.owner;
      ctx.before.isGlobal = was?.isGlobal;
      // Its collaborators lose sight of it once it's deleted: ask now.
      ctx.before.collaborators = await collaboratorsOf(kind, id);
    },
    after: async (ctx) => {
      const id = (idFrom.reply ? str(ctx.reply?.[idFrom.reply]) : null) ?? (idFrom.param ? ctx.params[idFrom.param] : null);
      if (!id) return [];
      const now = await ownerOfResource(kind, id);
      const act = action(ctx.req);
      // A new version (a module's save): its number, so it is never squashed with the last one.
      const v = typeof ctx.reply?.docVersion === 'number' ? { v: ctx.reply.docVersion } : {};
      const extra = [...extraUsers(ctx), ...((ctx.before.collaborators as string[] | undefined) ?? [])];
      if (ctx.before.isGlobal || now?.isGlobal) return [{ hint: { kind, id, action: act, ...v }, reach: { everyone: true } }];
      const out: Array<{ hint: Hint; reach?: Reach }> = [];
      const was = ctx.before.owner as HintOwner | undefined;
      if (was) out.push({ hint: { kind, owner: was, id, action: act, ...v }, reach: { users: extra } });
      if (now?.owner && !sameOwner(was, now.owner)) out.push({ hint: { kind, owner: now.owner, id, action: act, ...v }, reach: { users: extra } });
      if (out.length === 0 && extra.length) out.push({ hint: { kind, id, action: act, ...v }, reach: { users: extra } });
      return out;
    },
  };
}

async function collaboratorsOf(kind: ResourceKind, id: string): Promise<string[]> {
  if (kind === 'layout') {
    return (await db.select({ u: schema.layoutCollaborators.userId }).from(schema.layoutCollaborators).where(eq(schema.layoutCollaborators.layoutId, id)).all()).map((r) => r.u);
  }
  if (kind === 'module') {
    return (await db.select({ u: schema.moduleCollaborators.userId }).from(schema.moduleCollaborators).where(eq(schema.moduleCollaborators.moduleId, id)).all()).map((r) => r.u);
  }
  if (kind === 'custom-part') {
    return (await db.select({ u: schema.customPartCollaborators.userId }).from(schema.customPartCollaborators).where(eq(schema.customPartCollaborators.customPartId, id)).all()).map((r) => r.u);
  }
  return [];
}

async function memberIds(orgId: string): Promise<string[]> {
  return (await db.select({ u: schema.orgMembers.userId }).from(schema.orgMembers).where(eq(schema.orgMembers.orgId, orgId)).all()).map((r) => r.u);
}

/**
 * A club itself (settings, members, invites, join requests). Goes to the
 * club's members before and after the change (so someone removed, or a
 * club deleted, still drops off their screens), the person acting, and
 * `extraUsers`.
 */
function club(
  orgFrom: (ctx: HintCtx) => Promise<string | null>,
  extraUsers: (ctx: HintCtx) => (string | null)[] = () => [],
): HintSpec {
  return {
    before: async (ctx) => {
      const orgId = await orgFrom(ctx);
      ctx.before.orgId = orgId;
      ctx.before.members = orgId ? await memberIds(orgId) : [];
    },
    after: async (ctx) => {
      const orgId = (ctx.before.orgId as string | null) ?? (await orgFrom(ctx));
      if (!orgId) return [];
      const users = [ctx.userId, ...extraUsers(ctx), ...((ctx.before.members as string[] | undefined) ?? [])];
      return [{ hint: { kind: 'club', owner: { kind: 'org', id: orgId }, id: orgId, action: action(ctx.req) }, reach: { users } }];
    },
  };
}

const bySlug = (ctx: HintCtx) => orgIdBySlug(ctx.params.slug ?? '');

/** The account an invite is for, when there is one: their Home lists it ("You're invited to a club"). */
async function inviteeOf(ctx: HintCtx): Promise<string | null> {
  let email: string | null = null;
  if (ctx.params.inviteId) {
    const inv = await db.select({ e: schema.orgInvites.invitedEmail }).from(schema.orgInvites).where(eq(schema.orgInvites.id, ctx.params.inviteId)).get();
    email = inv?.e ?? null;
  } else if (typeof ctx.body.userId === 'string') {
    return ctx.body.userId;
  } else if (typeof ctx.body.email === 'string') {
    email = ctx.body.email;
  }
  if (!email) return null;
  const u = await db.select({ id: schema.users.id }).from(schema.users).where(sql`lower(${schema.users.email}) = ${email.trim().toLowerCase()}`).get();
  return u?.id ?? null;
}

/** A club invite made, revoked or sent again: the club's members, and the person invited (their own list). */
const clubInvite: HintSpec = {
  before: async (c) => {
    c.before.invitee = await inviteeOf(c);
    await club(bySlug).before!(c);
  },
  after: async (c) => {
    const out = await club(bySlug).after(c);
    const invitee = c.before.invitee as string | null;
    if (invitee) out.push({ hint: { kind: 'me', owner: { kind: 'user', id: invitee }, action: 'org-invites' } });
    return out;
  },
};

/** Something only the signed-in person sees (their account, settings, devices). */
const me: HintSpec = {
  after: async (ctx) => (ctx.userId ? [{ hint: { kind: 'me', owner: { kind: 'user', id: ctx.userId }, action: action(ctx.req) } }] : []),
};

/**
 * A new name: it shows wherever other people see this person (club member
 * lists, the catalog's "by" lines, share lists, version history), so
 * those refetch too, not just the person's own tabs.
 */
const rename: HintSpec = {
  after: async (ctx) => {
    const uid = ctx.userId;
    if (!uid) return [];
    const out: Array<{ hint: Hint; reach?: Reach }> = [{ hint: { kind: 'me', owner: { kind: 'user', id: uid }, action: 'update:name' } }];
    const clubs = await db.select({ orgId: schema.orgMembers.orgId }).from(schema.orgMembers).where(eq(schema.orgMembers.userId, uid)).all();
    for (const c of clubs) out.push({ hint: { kind: 'club', owner: { kind: 'org', id: c.orgId }, id: c.orgId, action: 'update:name' } });
    out.push({ hint: { kind: 'catalog', action: 'update:name' }, reach: { everyone: true } });
    // Everyone sharing a layout or module with them sees them in its share list.
    const L = schema.layoutCollaborators;
    const layoutIds = [
      ...(await db.select({ id: schema.layouts.id }).from(schema.layouts).where(eq(schema.layouts.ownerUserId, uid)).all()).map((r) => r.id),
      ...(await db.select({ id: L.layoutId }).from(L).where(eq(L.userId, uid)).all()).map((r) => r.id),
    ];
    const M = schema.moduleCollaborators;
    const moduleIds = [
      ...(await db.select({ id: schema.modules.id }).from(schema.modules).where(eq(schema.modules.ownerUserId, uid)).all()).map((r) => r.id),
      ...(await db.select({ id: M.moduleId }).from(M).where(eq(M.userId, uid)).all()).map((r) => r.id),
    ];
    if (layoutIds.length) {
      const users = (await db.select({ u: L.userId }).from(L).where(inArray(L.layoutId, layoutIds)).all()).map((r) => r.u);
      const owners = (await db.select({ u: schema.layouts.ownerUserId }).from(schema.layouts).where(inArray(schema.layouts.id, layoutIds)).all()).map((r) => r.u);
      out.push({ hint: { kind: 'layout', action: 'update:name' }, reach: { ownerless: true, users: [...users, ...owners] } });
    }
    if (moduleIds.length) {
      const users = (await db.select({ u: M.userId }).from(M).where(inArray(M.moduleId, moduleIds)).all()).map((r) => r.u);
      const owners = (await db.select({ u: schema.modules.ownerUserId }).from(schema.modules).where(inArray(schema.modules.id, moduleIds)).all()).map((r) => r.u);
      out.push({ hint: { kind: 'module', action: 'update:name' }, reach: { ownerless: true, users: [...users, ...owners] } });
    }
    return out;
  },
};

/** Site-wide data everyone sees (global parts, site settings). */
function everyone(kind: Hint['kind']): HintSpec {
  return { after: async (ctx) => [{ hint: { kind, action: action(ctx.req) }, reach: { everyone: true } }] };
}

/** Admin-only data: site admins (and, for `alsoUser`, the person it is about). */
function adminOnly(kind: Hint['kind'], alsoUser?: (ctx: HintCtx) => string | null): HintSpec {
  return {
    after: async (ctx) => {
      const out: Array<{ hint: Hint; reach?: Reach }> = [{ hint: { kind, action: action(ctx.req) }, reach: { ownerless: true } }];
      const u = alsoUser?.(ctx);
      if (u) out.push({ hint: { kind: 'me', owner: { kind: 'user', id: u }, action: action(ctx.req) } });
      return out;
    },
  };
}

async function catalogItemOwner(itemId: string): Promise<HintOwner | undefined> {
  const row = await db
    .select({ u: schema.catalogItems.ownerUserId, o: schema.catalogItems.ownerOrgId })
    .from(schema.catalogItems)
    .where(eq(schema.catalogItems.id, itemId))
    .get();
  if (!row) return undefined;
  return row.o ? { kind: 'org', id: row.o } : row.u ? { kind: 'user', id: row.u } : undefined;
}

async function itemOfVersion(versionId: string): Promise<string | null> {
  const row = await db.select({ i: schema.catalogItemVersions.itemId }).from(schema.catalogItemVersions).where(eq(schema.catalogItemVersions.id, versionId)).get();
  return row?.i ?? null;
}

/**
 * The public catalog. Anything that changes what's published goes to
 * everyone; a submission or a decline goes to its owner and moderators.
 */
function catalog(itemFrom: (ctx: HintCtx) => Promise<string | null>, publicChange: boolean): HintSpec {
  return {
    after: async (ctx) => {
      const itemId = await itemFrom(ctx);
      const owner = itemId ? await catalogItemOwner(itemId) : undefined;
      const hint: Hint = { kind: 'catalog', action: action(ctx.req), ...(owner ? { owner } : {}), ...(itemId ? { id: itemId } : {}) };
      return [{ hint, reach: publicChange ? { everyone: true } : { users: [ctx.userId] } }];
    },
  };
}

/** Adding a catalog item puts a module, part, layout or venue in your things, or your club's. */
const catalogAdd: HintSpec = {
  after: async (ctx) => {
    const k = ctx.reply?.kind;
    const kind: ResourceKind = k === 'part' ? 'custom-part' : k === 'layout' ? 'layout' : k === 'venue' ? 'venue' : 'module';
    const id = str(ctx.reply?.id);
    if (!id) return [];
    const now = await ownerOfResource(kind, id);
    const out: Array<{ hint: Hint; reach?: Reach }> = [];
    if (now?.owner) out.push({ hint: { kind, owner: now.owner, id, action: 'create' } });
    // The item's "uses" count is public.
    out.push({ hint: { kind: 'catalog', id: ctx.params.id ?? '', action: 'add' }, reach: { everyone: true } });
    return out;
  },
};

interface CollectionState {
  /** In the public catalog: everyone may see it. */
  listed: boolean;
  /** Its club (whose members see it), else its curator. */
  owner?: HintOwner;
}

async function collectionState(id: string): Promise<CollectionState | null> {
  const row = await db
    .select({
      status: schema.catalogCollections.status,
      audience: schema.catalogCollections.audience,
      u: schema.catalogCollections.ownerUserId,
      org: schema.catalogCollections.orgId,
    })
    .from(schema.catalogCollections)
    .where(eq(schema.catalogCollections.id, id))
    .get();
  if (!row) return null;
  const owner: HintOwner | undefined = row.org ? { kind: 'org', id: row.org } : row.u ? { kind: 'user', id: row.u } : undefined;
  return { listed: row.status === 'public' && row.audience === 'everyone', ...(owner ? { owner } : {}) };
}

/**
 * A catalog collection. Everyone hears when what's in the public catalog
 * changes (it was or is listed); otherwise its club's members (or its
 * curator), the person acting, and moderators (who hear every catalog
 * hint). Read before the change too, so a deleted one still reaches them.
 */
function collection(idFrom: { param?: string; reply?: string } = { param: 'id' }): HintSpec {
  return {
    before: async (ctx) => {
      const id = idFrom.param ? ctx.params[idFrom.param] : null;
      ctx.before.state = id ? await collectionState(id) : null;
    },
    after: async (ctx) => {
      const id = (idFrom.reply ? str(ctx.reply?.[idFrom.reply]) : null) ?? (idFrom.param ? (ctx.params[idFrom.param] ?? null) : null);
      if (!id) return [];
      const was = ctx.before.state as CollectionState | null | undefined;
      const now = await collectionState(id);
      const owner = now?.owner ?? was?.owner;
      const hint: Hint = { kind: 'catalog', id, action: action(ctx.req), ...(owner ? { owner } : {}) };
      return [{ hint, reach: was?.listed || now?.listed ? { everyone: true } : { users: [ctx.userId] } }];
    },
  };
}

/** "Add all" puts modules and parts in your things, or your club's; the items' use counts are public. */
const collectionAdd: HintSpec = {
  after: async (ctx) => {
    const added = Array.isArray(ctx.reply?.added) ? (ctx.reply.added as { kind?: unknown; id?: unknown }[]) : [];
    const out: Array<{ hint: Hint; reach?: Reach }> = [];
    const seen = new Set<string>();
    for (const a of added) {
      const kind: ResourceKind = a.kind === 'part' ? 'custom-part' : a.kind === 'layout' ? 'layout' : a.kind === 'venue' ? 'venue' : 'module';
      const id = str(a.id);
      if (!id) continue;
      const now = await ownerOfResource(kind, id);
      const key = `${kind}:${now?.owner?.kind}:${now?.owner?.id}`;
      if (!now?.owner || seen.has(key)) continue;
      seen.add(key);
      out.push({ hint: { kind, owner: now.owner, id, action: 'create' } });
    }
    if (added.length) {
      const c = await collectionState(ctx.params.id ?? '');
      out.push({
        hint: { kind: 'catalog', id: ctx.params.id ?? '', action: 'add', ...(c?.owner ? { owner: c.owner } : {}) },
        reach: c?.listed ? { everyone: true } : { users: [ctx.userId] },
      });
    }
    return out;
  },
};

/**
 * A club trusted or not: its members (its page and review queue), and
 * everyone (the "Trusted club" badge on its public items, and where its
 * waiting items are reviewed).
 */
const trust: HintSpec = {
  after: async (ctx) => {
    const orgId = await orgIdBySlug(ctx.params.slug ?? '');
    if (!orgId) return [];
    return [
      { hint: { kind: 'club', owner: { kind: 'org', id: orgId }, id: orgId, action: 'update:trust' }, reach: { users: [ctx.userId] } },
      { hint: { kind: 'catalog', action: 'update:trust' }, reach: { everyone: true } },
    ];
  },
};

const param = (name: string) => (ctx: HintCtx) => ctx.params[name] ?? null;

async function joinRequester(id: string): Promise<string | null> {
  const row = await db.select({ u: schema.orgJoinRequests.userId }).from(schema.orgJoinRequests).where(eq(schema.orgJoinRequests.id, id)).get();
  return row?.u ?? null;
}

/**
 * A warning: to whoever received it, and whoever may see it. Site
 * warnings: site admins and moderators. Club warnings: the club's members
 * whose roles see its Warnings list (access/clubNotices.ts), and site
 * admins (not moderators).
 */
function warningHint(idFrom: (ctx: HintCtx) => string | null): HintSpec {
  return {
    after: async (ctx) => {
      const id = idFrom(ctx);
      if (!id) return [];
      const w = await db.select().from(schema.warnings).where(eq(schema.warnings.id, id)).get();
      if (!w) return [];
      const users = [
        ...(await recipientsOf(w)),
        ...(w.clubOrgId ? await clubRunners(w.clubOrgId) : []),
        ...(await staffIds(w.scope === 'site')),
      ];
      return [{ hint: { kind: 'warning', id: w.id, action: action(ctx.req) }, reach: { ownerless: true, users } }];
    },
  };
}

/**
 * A club's thing handed back to its author (routes/ownership.ts): the
 * thing's hints (the club, which also gains its copy, and the author),
 * and the note to the members who look after the club's things.
 */
function returned(kind: ResourceKind): HintSpec {
  const r = resource(kind);
  const note = warningHint((c) => str(c.reply?.noticeId));
  return {
    before: async (ctx) => r.before?.(ctx),
    after: async (ctx) => [...(await r.after(ctx)), ...(await note.after(ctx))],
  };
}

/**
 * Your settings; and when you show or hide when you were last active,
 * the members lists of your clubs.
 */
const preferences: HintSpec = {
  after: async (ctx) => {
    const out = await me.after(ctx);
    const prefs = ctx.body.prefs as Record<string, unknown> | undefined;
    if (ctx.userId && prefs && typeof prefs === 'object' && 'shareLastActive' in prefs) {
      const clubs = await db.select({ o: schema.orgMembers.orgId }).from(schema.orgMembers).where(eq(schema.orgMembers.userId, ctx.userId)).all();
      for (const { o } of clubs) {
        out.push({ hint: { kind: 'club', owner: { kind: 'org', id: o }, id: o, action: 'update:members' }, reach: { users: await memberIds(o) } });
      }
    }
    return out;
  },
};

export const ROUTE_HINTS: Record<string, HintSpec> = {
  // ---- account (other tabs and the desktop app of the same person)
  'PATCH /api/auth/me': rename,
  'POST /api/auth/link': me,
  'DELETE /api/auth/link': me,
  'POST /api/auth/device/approve': me,
  'POST /api/auth/device/deny': me,
  'DELETE /api/tokens/:id': me,
  // The desktop's Sign Out: the website's Browsers and devices list drops it at once.
  'DELETE /api/tokens/current': me,
  // Other tabs' Browsers and devices lists (the signed-out ones are closed anyway).
  'POST /api/auth/password/change': me,
  'DELETE /api/auth/sessions/:id': me,
  'POST /api/auth/sessions/sign-out-others': me,
  'PUT /api/me/preferences': preferences,
  'POST /api/me/privacy/exports': me,
  'POST /api/me/deletion': adminOnly('admin', (c) => c.userId),
  'POST /api/admin/privacy/requests': adminOnly('admin'),
  'PATCH /api/admin/privacy/requests/:id': adminOnly('admin'),
  'POST /api/admin/privacy/requests/:id/export': adminOnly('admin'),
  'POST /api/admin/privacy/requests/:id/erase': adminOnly('admin'),
  'POST /api/admin/privacy/requests/:id/restrict': adminOnly('admin'),

  // ---- layouts
  'POST /api/layouts': resource('layout', { reply: 'id' }),
  'PATCH /api/layouts/:id': resource('layout'),
  'DELETE /api/layouts/:id': resource('layout'),
  'POST /api/layouts/:id/copy': resource('layout', { reply: 'id' }),
  'POST /api/layouts/:id/public-share': resource('layout'),
  'DELETE /api/layouts/:id/public-share': resource('layout'),
  'POST /api/layouts/:id/background-image': resource('layout'),
  'DELETE /api/layouts/:id/background-image': resource('layout'),
  'POST /api/layouts/:id/invites': resource('layout'),
  'DELETE /api/layouts/:id/invites/:inviteId': resource('layout'),
  'PATCH /api/layouts/:id/collaborators/:userId': resource('layout', { param: 'id' }, (c) => [c.params.userId ?? null]),
  'DELETE /api/layouts/:id/collaborators/:userId': resource('layout', { param: 'id' }, (c) => [c.params.userId ?? null]),
  'POST /api/invites/:token': resource('layout', { reply: 'layoutId' }),
  'POST /api/layouts/:id/transfer': resource('layout'),
  'POST /api/transfers/:token': resource('layout', { reply: 'layoutId' }),
  'DELETE /api/layouts/:id/transfer/:transferId': resource('layout'),
  'POST /api/layouts/:id/take-back': returned('layout'),
  'POST /api/layouts/:id/give-back': returned('layout'),

  // ---- modules
  'POST /api/modules': resource('module', { reply: 'id' }),
  'POST /api/modules/:id/copy': resource('module', { reply: 'id' }),
  'PATCH /api/modules/:id': resource('module'),
  'DELETE /api/modules/:id': resource('module'),
  'PUT /api/modules/:id/snapshot': resource('module'),
  'PUT /api/modules/:id/thumbnail': resource('module'),
  'POST /api/modules/:id/versions/:n/restore': resource('module'),
  'POST /api/modules/:id/invites': resource('module'),
  'DELETE /api/modules/:id/invites/:inviteId': resource('module'),
  'POST /api/module-invites/:token': resource('module', { reply: 'moduleId' }),
  'DELETE /api/modules/:id/collaborators/:userId': resource('module', { param: 'id' }, (c) => [c.params.userId ?? null]),
  'POST /api/modules/:id/transfer': resource('module'),
  'POST /api/modules/:id/take-back': returned('module'),
  'POST /api/modules/:id/give-back': returned('module'),

  // ---- venues
  'POST /api/venues': resource('venue', { reply: 'id' }),
  'PATCH /api/venues/:id': resource('venue'),
  'DELETE /api/venues/:id': resource('venue'),
  // Recently deleted: a restored thing shows again wherever it's listed; the list itself is the person's own.
  'POST /api/trash/:id/restore': {
    after: async (c) => {
      const kind = c.reply?.kind;
      const id = str(c.reply?.id);
      if ((kind !== 'layout' && kind !== 'module' && kind !== 'venue') || !id) return [];
      return resource(kind, { reply: 'id' }).after(c);
    },
  },
  'DELETE /api/trash/:id': me,
  'POST /api/venues/:id/copy': resource('venue', { reply: 'id' }),
  'POST /api/venues/:id/move': resource('venue'),
  'POST /api/venues/:id/take-back': returned('venue'),
  'POST /api/venues/:id/give-back': returned('venue'),

  // ---- custom parts
  'POST /api/custom-parts': resource('custom-part', { reply: 'id' }),
  'PUT /api/custom-parts/:id': resource('custom-part'),
  'DELETE /api/custom-parts/:id': resource('custom-part'),
  'POST /api/custom-parts/:id/invites': resource('custom-part'),
  'DELETE /api/custom-parts/:id/invites/:inviteId': resource('custom-part'),
  'POST /api/part-invites/:token': resource('custom-part', { reply: 'partId' }),
  'PATCH /api/custom-parts/:id/collaborators/:userId': resource('custom-part', { param: 'id' }, (c) => [c.params.userId ?? null]),
  'DELETE /api/custom-parts/:id/collaborators/:userId': resource('custom-part', { param: 'id' }, (c) => [c.params.userId ?? null]),
  'POST /api/custom-parts/:id/move': resource('custom-part'),
  'PATCH /api/custom-parts/:id/listing': resource('custom-part'),
  'POST /api/custom-parts/:id/copy': resource('custom-part', { reply: 'id' }),
  'POST /api/custom-parts/:id/take-back': returned('custom-part'),
  'POST /api/custom-parts/:id/give-back': returned('custom-part'),

  // ---- public catalog
  'POST /api/catalog/submissions': catalog(async (c) => str(c.reply?.id), false),
  'POST /api/catalog/items/:id/withdraw': catalog(async (c) => c.params.id ?? null, true),
  'POST /api/catalog/items/:id/add': catalogAdd,
  'POST /api/catalog/copies/:copyId/update': {
    // The copy is a module or a custom part: whichever has that id.
    after: async (c) => {
      const id = c.params.copyId ?? '';
      const kind: ResourceKind = (await ownerOfResource('module', id)) ? 'module' : 'custom-part';
      return resource(kind, { param: 'copyId' }).after(c);
    },
  },
  'POST /api/moderation/versions/:versionId/approve': catalog(async (c) => itemOfVersion(c.params.versionId ?? ''), true),
  'POST /api/moderation/versions/:versionId/decline': catalog(async (c) => itemOfVersion(c.params.versionId ?? ''), false),
  'POST /api/moderation/items/:id/unpublish': catalog(async (c) => c.params.id ?? null, true),
  'POST /api/moderation/items/:id/restore': catalog(async (c) => c.params.id ?? null, true),
  // Several at once: one hint for everyone (each list refetches).
  'POST /api/moderation/bulk': catalog(async () => null, true),
  'PUT /api/catalog/items/:id/cover': catalog(async (c) => c.params.id ?? null, true),
  'DELETE /api/catalog/items/:id/cover': catalog(async (c) => c.params.id ?? null, true),
  'POST /api/moderation/items/:id/cover/approve': catalog(async (c) => c.params.id ?? null, true),
  'POST /api/moderation/items/:id/cover/decline': catalog(async (c) => c.params.id ?? null, false),

  // ---- catalog collections
  'POST /api/catalog/collections': collection({ reply: 'id' }),
  'PATCH /api/catalog/collections/:id': collection(),
  'PUT /api/catalog/collections/:id/cover': collection(),
  'DELETE /api/catalog/collections/:id/cover': collection(),
  'POST /api/catalog/collections/:id/withdraw': collection(),
  'POST /api/catalog/collections/:id/dismiss-note': collection(),
  'POST /api/catalog/collections/:id/add': collectionAdd,
  'POST /api/catalog/collections/:id/items': collection(),
  'DELETE /api/catalog/collections/:id': collection(),
  'POST /api/moderation/collections/:id/remove': collection(),
  // Several at once: one hint for everyone (each list refetches).
  'POST /api/moderation/collections/bulk': catalog(async () => null, true),

  // ---- trusted clubs
  'POST /api/moderation/clubs/:slug/trust': trust,
  'POST /api/orgs/:slug/review/versions/:id/approve': catalog(async (c) => itemOfVersion(c.params.id ?? ''), true),
  'POST /api/orgs/:slug/review/versions/:id/decline': catalog(async (c) => itemOfVersion(c.params.id ?? ''), false),
  'POST /api/orgs/:slug/review/items/:id/unpublish': catalog(async (c) => c.params.id ?? null, true),
  'POST /api/orgs/:slug/review/items/:id/cover/approve': catalog(async (c) => c.params.id ?? null, true),
  'POST /api/orgs/:slug/review/items/:id/cover/decline': catalog(async (c) => c.params.id ?? null, false),
  'POST /api/orgs/:slug/review/collections/:id/approve': collection(),
  'POST /api/orgs/:slug/review/collections/:id/decline': collection(),
  'POST /api/orgs/:slug/review/collections/:id/unpublish': collection(),
  'POST /api/moderation/collections/:id/approve': collection(),
  'POST /api/moderation/collections/:id/decline': collection(),
  'POST /api/moderation/collections/:id/unpublish': collection(),
  'POST /api/moderation/collections/:id/restore': collection(),
  'POST /api/moderation/collections/:id/feature': collection(),

  // ---- clubs
  'POST /api/orgs': club(async (c) => str(c.reply?.id)),
  'PATCH /api/orgs/:slug': club(bySlug),
  'PUT /api/orgs/:slug/logo': club(bySlug),
  'DELETE /api/orgs/:slug/logo': club(bySlug),
  'DELETE /api/orgs/:slug': club(bySlug),
  'POST /api/orgs/:slug/restore': {
    after: async (c) => {
      const orgId = await bySlug(c);
      return orgId ? [{ hint: { kind: 'club', owner: { kind: 'org', id: orgId }, id: orgId, action: 'update:restore' }, reach: { users: [c.userId] } }] : [];
    },
  },
  'POST /api/orgs/:slug/exports': me,
  'POST /api/orgs/:slug/move-all': {
    after: async (c) => {
      const orgId = await bySlug(c);
      const kind = c.body.kind === 'modules' ? 'module' : 'layout';
      const out: Array<{ hint: Hint; reach?: Reach }> = [];
      if (orgId) out.push({ hint: { kind, owner: { kind: 'org', id: orgId }, action: 'update:move' } });
      const toUser = str(c.body.toUserId);
      const toOrg = str(c.body.toOrgSlug) ? await orgIdBySlug(str(c.body.toOrgSlug)!) : null;
      if (toUser) out.push({ hint: { kind, owner: { kind: 'user', id: toUser }, action: 'update:move' } });
      if (toOrg) out.push({ hint: { kind, owner: { kind: 'org', id: toOrg }, action: 'update:move' } });
      return out;
    },
  },
  'POST /api/orgs/:slug/hand-over': club(bySlug),
  'POST /api/orgs/:slug/invites': clubInvite,
  'DELETE /api/orgs/:slug/invites/:inviteId': clubInvite,
  'POST /api/orgs/:slug/invites/:inviteId/resend': clubInvite,
  'PATCH /api/orgs/:slug/members/:userId': club(bySlug, (c) => [c.params.userId ?? null]),
  // Club roles: what a role allows changes what its holders may do, so every member hears.
  'POST /api/orgs/:slug/roles': club(bySlug),
  'PATCH /api/orgs/:slug/roles/:roleId': club(bySlug),
  'DELETE /api/orgs/:slug/roles/:roleId': club(bySlug),
  'DELETE /api/orgs/:slug/members/:userId': club(bySlug, (c) => [c.params.userId ?? null]),
  'PUT /api/orgs/:slug/part-libraries/:libraryId': club(bySlug),
  'DELETE /api/orgs/:slug/part-libraries/:libraryId': club(bySlug),
  'POST /api/org-invites/:token': club(async (c) => str(c.reply?.orgId)),
  'POST /api/orgs/:slug/join': club(bySlug),
  'DELETE /api/orgs/:slug/join': club(bySlug),
  'POST /api/orgs/:slug/join-requests/:id/approve': {
    before: async (c) => {
      c.before.requester = await joinRequester(c.params.id ?? '');
      await club(bySlug).before!(c);
    },
    after: (c) => club(bySlug, () => [c.before.requester as string | null]).after(c),
  },
  'POST /api/orgs/:slug/join-requests/:id/decline': {
    before: async (c) => {
      c.before.requester = await joinRequester(c.params.id ?? '');
      await club(bySlug).before!(c);
    },
    after: (c) => club(bySlug, () => [c.before.requester as string | null]).after(c),
  },

  // ---- warnings
  'POST /api/admin/warnings': warningHint((c) => str(c.reply?.id)),
  'POST /api/orgs/:slug/warnings': warningHint((c) => str(c.reply?.id)),
  'POST /api/notices/:id/acknowledge': warningHint((c) => c.params.id ?? null),
  'POST /api/notices/acknowledge-all': {
    // Each dismissed note, to whoever else sees it (a club's other runners).
    after: async (ctx) => {
      const ids = Array.isArray(ctx.reply?.acknowledged) ? (ctx.reply.acknowledged as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      const out = [];
      for (const id of ids) out.push(...(await warningHint(() => id).after!(ctx)));
      return out;
    },
  },

  // ---- site admin
  'PATCH /api/admin/users/:id': adminOnly('admin', param('id')),
  'DELETE /api/admin/users/:id': adminOnly('admin'),
  'POST /api/admin/users/:id/sessions/revoke-all': adminOnly('admin', param('id')),
  'DELETE /api/admin/orgs/:id': club(async (c) => c.params.id ?? null),
  'POST /api/admin/orgs/:id/restore': {
    after: async (c) => [
      { hint: { kind: 'admin', action: 'update:restore' }, reach: { ownerless: true } },
      { hint: { kind: 'club', owner: { kind: 'org', id: c.params.id ?? '' }, id: c.params.id ?? '', action: 'update:restore' }, reach: { users: [c.userId] } },
    ],
  },
  'POST /api/admin/orgs/:id/erase': adminOnly('admin'),
  'DELETE /api/admin/layouts/:id': resource('layout'),
  'POST /api/admin/global-parts': everyone('parts-library'),
  'DELETE /api/admin/global-parts/:id': everyone('parts-library'),
  'POST /api/admin/part-libraries': everyone('parts-library'),
  'POST /api/admin/part-libraries/install-base': everyone('parts-library'),
  'POST /api/admin/part-libraries/download': everyone('parts-library'),
  'PATCH /api/admin/part-libraries/:id': everyone('parts-library'),
  'POST /api/admin/part-libraries/:id/update': everyone('parts-library'),
  'DELETE /api/admin/part-libraries/:id': everyone('parts-library'),
  'POST /api/admin/reload-parts': everyone('parts-library'),
  'PATCH /api/admin/settings': everyone('settings'),
  'PATCH /api/admin/limits': adminOnly('limits'),
  'PUT /api/admin/users/:id/limits': adminOnly('limits', param('id')),
  'PUT /api/admin/orgs/:id/limits': {
    before: (c) => club(async (cc) => cc.params.id ?? null).before!(c),
    after: async (c) => [
      { hint: { kind: 'limits', action: action(c.req) }, reach: { ownerless: true } },
      ...(await club(async (cc) => cc.params.id ?? null).after(c)),
    ],
  },
};

/**
 * Changing routes that send no hint, and why. Signing in and out, and
 * reads done with POST, change nothing anyone else is looking at.
 */
export const NO_HINT: Record<string, string> = {
  'POST /api/auth/password/register': 'a new account: nobody is looking at it yet',
  'POST /api/auth/password/resend-verification': 'sends an email only',
  'POST /api/auth/password/verify-email/:token': 'signs in; the new page loads fresh',
  'POST /api/auth/password/login': 'signs in; the new page loads fresh',
  'POST /api/auth/password/set': 'your own password: nothing anyone else sees',
  'POST /api/auth/password/forgot': 'sends an email only',
  'POST /api/auth/password/reset': 'signs in and every other sign-in ends; the new page loads fresh',
  'POST /api/auth/demo': 'signs in as the demo account; the new page loads fresh',
  'POST /api/admin/demo/reset': 'the reset sends its own hints to the demo account and admins (demo/reset.ts)',
  'POST /api/auth/logout': 'signs out',
  'POST /api/auth/device/code': 'starts a device sign-in; nothing to show yet',
  'POST /api/auth/device/token': 'the desktop polling for its token',
  'POST /api/auth/device/lookup': 'reads a pending device code',
  'POST /api/layouts/:id/compare': 'a read (compares two copies)',
  'POST /api/metrics/client': 'anonymous client timing beacon',
};

/** Route key as the table spells it. */
export function routeKey(method: string, url: string): string {
  return `${method} ${url}`;
}

declare module 'fastify' {
  interface FastifyRequest {
    hintCtx?: HintCtx;
  }
}

/**
 * Register after attachUser. Errors are logged, never thrown at the
 * request: a missed hint costs a refresh, not a failed save.
 */
export function registerChangeHints(app: FastifyInstance): void {
  app.addHook('preHandler', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const spec = ROUTE_HINTS[routeKey(req.method, req.routeOptions.url ?? '')];
    if (!spec) return;
    const ctx: HintCtx = {
      req,
      params: (req.params ?? {}) as Record<string, string>,
      body: (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>,
      reply: null,
      userId: req.user?.id ?? null,
      before: {},
    };
    req.hintCtx = ctx;
    try {
      await spec.before?.(ctx);
    } catch (err) {
      req.log.warn({ err }, 'live hint: before failed');
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const ctx = req.hintCtx;
    if (!ctx || reply.statusCode < 200 || reply.statusCode >= 300) return payload;
    if (typeof payload === 'string' && payload.length < 65_536 && payload.startsWith('{')) {
      try {
        ctx.reply = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        ctx.reply = null;
      }
    }
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const ctx = req.hintCtx;
    if (!ctx || reply.statusCode < 200 || reply.statusCode >= 300) return;
    const spec = ROUTE_HINTS[routeKey(req.method, req.routeOptions.url ?? '')];
    if (!spec) return;
    try {
      for (const { hint, reach } of await spec.after(ctx)) await publish(hint, reach);
    } catch (err) {
      req.log.warn({ err }, 'live hint: after failed');
    }
  });
}
