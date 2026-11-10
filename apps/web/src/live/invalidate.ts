// What to refetch when something changes. One table, used both by this
// tab's own changes (`invalidateFor` after a save) and by the live hints
// other people's changes send (live/LiveUpdates.tsx), so every list that
// shows a thing updates the same way however it changed.
//
// Keys are prefixes: ['layout'] refetches ['layout', id] for every id.
// Only queries on screen refetch; the rest are marked stale and refetch
// when they next show.

import type { QueryClient, QueryKey } from '@tanstack/react-query';

/** Keep in step with apps/server/src/events/hub.ts HINT_KINDS. */
export const HINT_KINDS = [
  'layout',
  'module',
  'venue',
  'custom-part',
  'catalog',
  'club',
  'me',
  'transfer',
  'admin',
  'settings',
  'limits',
  'parts-library',
  'warning',
] as const;
export type HintKind = (typeof HINT_KINDS)[number];

export interface Hint {
  kind: HintKind;
  owner?: { kind: 'user' | 'org'; id: string };
  id?: string;
  action?: string;
  /** The thing's version after the change (a module's save), when the server says. */
  v?: number;
}

// Admin pages that count or list people's things.
const ADMIN_LISTS: QueryKey[] = [['admin-users'], ['admin-user-detail'], ['admin-orgs'], ['admin-org-detail'], ['admin-layouts']];

/** Club changes that change whose parts libraries you see. */
const MEMBERSHIP_CHANGE = /part-libraries|members|join|approve|org-invites|^delete$/;

/** Collections hold modules and parts: one that's deleted or moves away drops out of them. */
const COLLECTIONS: QueryKey[] = [['catalog-collections'], ['catalog-collection'], ['catalog-collections-mine'], ['club-collections']];

const KEYS: Record<HintKind, (h: Hint) => QueryKey[]> = {
  layout: () => [['admin-audit'], ['admin-deleted-layouts'], ['layouts'], ['layout'], ['collaborators'], ['audit'], ['club-summary'], ['transfer-preview'], ...ADMIN_LISTS],
  module: () => [['modules'], ['module'], ['module-versions'], ['module-collaborators'], ['catalog-copies'], ['club-summary'], ...COLLECTIONS, ...ADMIN_LISTS],
  venue: () => [['venues'], ['venue'], ['venue-library'], ['club-summary']],
  'custom-part': () => [['custom-parts'], ['custom-part-collaborators'], ['set-move-plan'], ['parts-catalog'], ['catalog-copies'], ['club-summary'], ...COLLECTIONS],
  catalog: () => [
    ['catalog-items'], ['catalog-mine'], ['catalog-copies'], ['moderation'], ['modules'], ['custom-parts'],
    // A layout's or venue's own page: its details, and its published copy.
    ['catalog-item'], ['catalog-item-snapshot'], ['catalog-item-venue'], ['layouts'], ['venues'],
    // Collections: an item leaving the catalog changes them too.
    ...COLLECTIONS, ['moderation-collections'],
    // A trusted club's own queue, who's trusted, and how much waits
    // (on Manage the club and the Clubs list).
    ['club-review'], ['moderation-clubs'], ['org'], ['orgs'],
  ],
  club: (h) => [
    ['orgs'], ['org'], ['org-members'], ['org-join-requests'], ['my-org-invites'], ['join-request-count'], ['org-audit'],
    // Deleting a club: Clubs › Being deleted, and the delete screen.
    ['clubs-deleting'], ['club-deletion'],
    ['org-part-libraries'], ['org-user-search'], ['club-summary'], ['club-directory'],
    // Joining or leaving a club changes which layouts, modules, rooms and parts you see,
    // and a change to your club roles what you may do with the open one.
    ['layouts'], ['layout'], ['modules'], ['module'], ['venues'], ['venue-library'], ['custom-parts'], ['org-roles'],
    // …and its collections.
    ...COLLECTIONS,
    // …and whether it's trusted (its Review tab, its badge).
    ['club-review'],
    // …and the parts its part libraries add.
    ...(MEMBERSHIP_CHANGE.test(h.action ?? '') ? [['parts-catalog']] : []),
    ...ADMIN_LISTS,
  ],
  me: () => [['me'], ['preferences'], ['api-tokens'], ['sessions'], ['providers'], ['my-exports'], ['my-deletion'], ['club-exports'], ['my-org-invites']],
  transfer: () => [['layouts'], ['modules'], ['transfer-preview']],
  // …and the demo account's last reset (Admin › Settings and the dashboard).
  admin: () => [
    ...ADMIN_LISTS, ['admin-audit'], ['admin-abuse'], ['admin-settings'], ['admin-people'],
    // Admin › Privacy requests, and its badge.
    ['admin-privacy'], ['admin-privacy-summary'], ['admin-privacy-request'],
  ],
  settings: () => [['admin-settings'], ['catalog-settings'], ['providers'], ['admin-alerts'], ['privacy-page'], ['admin-privacy-summary']],
  limits: () => [['admin-limits'], ['admin-usage'], ['admin-abuse'], ['admin-user-detail'], ['admin-org-detail']],
  'parts-library': () => [['parts-catalog'], ['custom-parts'], ['admin-global-parts'], ['admin-part-libraries'], ['org-part-libraries']],
  warning: () => [['notices'], ['warnings'], ['admin-user-detail'], ['admin-org-detail'], ['org-warnings']],
};

export function isHintKind(v: unknown): v is HintKind {
  return typeof v === 'string' && (HINT_KINDS as readonly string[]).includes(v);
}

/** The query keys (prefixes) that show data of this kind. */
export function keysFor(hint: Hint): QueryKey[] {
  return KEYS[hint.kind](hint);
}

/**
 * Refetch everything that shows `kind`. Call it after a change in this
 * tab; other tabs and other people get the same through the live hints.
 */
export function invalidateFor(qc: QueryClient, kind: HintKind, extra: Omit<Hint, 'kind'> = {}): Promise<void> {
  return Promise.all(keysFor({ kind, ...extra }).map((queryKey) => refetchKey(qc, queryKey))).then(() => undefined);
}

/** Refetch one key (prefix). */
export function refetchKey(qc: QueryClient, queryKey: QueryKey, gone: ReadonlySet<string> = NONE_GONE): Promise<void> {
  if (gone.size === 0) return qc.invalidateQueries({ queryKey });
  // A deleted thing's own queries (['layout', id], ['module', id, 'info'] …)
  // keep what they showed: asking again would only bring a 404, and a
  // burst of 404s from one address is what a firewall bans (README,
  // "Operations: the 4xx profile"). The lists drop it on their refetch.
  return qc.invalidateQueries({ queryKey, predicate: (q) => !q.queryKey.some((k) => typeof k === 'string' && gone.has(k)) });
}

const NONE_GONE: ReadonlySet<string> = new Set();

/** The id of the thing a hint says was deleted, if it says so. */
export function deletedId(hint: Hint): string | null {
  return hint.action === 'delete' && hint.id ? hint.id : null;
}

/**
 * What to refetch when the window comes back into focus (in case a live
 * hint was missed while the stream was down): every list of things,
 * but not the big parts catalog, which only changes with a hint.
 */
export function focusKeys(): QueryKey[] {
  const seen = new Set<string>();
  const out: QueryKey[] = [];
  for (const kind of ['layout', 'module', 'venue', 'custom-part', 'club', 'catalog', 'warning'] as const) {
    for (const k of keysFor({ kind })) {
      const id = JSON.stringify(k);
      if (k[0] === 'parts-catalog' || seen.has(id)) continue;
      seen.add(id);
      out.push(k);
    }
  }
  return out;
}

/**
 * What a change this tab just made touched, from its method and path
 * (api.ts reports every successful write). The server sends the same
 * news to other tabs and people as live hints; this makes this tab's
 * own lists update straight away, stream or no stream.
 */
const WRITE_RULES: Array<[RegExp, HintKind[]]> = [
  [/^\/api\/(metrics|auth\/password\/resend-verification|auth\/device\/(code|token|lookup))\b|^\/api\/layouts\/[^/]+\/compare$/, []],
  [/^\/api\/(warnings|notices|admin\/warnings)\b|^\/api\/orgs\/[^/]+\/warnings\b/, ['warning']],
  [/^\/api\/(auth|tokens|me)\b/, ['me']],
  // Taking back or giving back: the thing, the club's copy, and the note to the club's runners.
  [/^\/api\/[^/]+\/[^/]+\/(take|give)-back$/, ['layout', 'module', 'venue', 'custom-part', 'warning']],
  [/^\/api\/layouts\/[^/]+\/transfer\b|^\/api\/transfers\b/, ['layout', 'transfer']],
  [/^\/api\/(layouts|invites)\b/, ['layout']],
  [/^\/api\/modules\/[^/]+\/transfer\b/, ['module', 'transfer']],
  [/^\/api\/(modules|module-invites)\b/, ['module']],
  [/^\/api\/venues\b/, ['venue']],
  [/^\/api\/(custom-parts|part-invites)\b/, ['custom-part']],
  // Adding or updating a catalog item puts a module or a part in your things.
  [/^\/api\/catalog\/((items|collections)\/[^/]+\/add|copies)\b/, ['catalog', 'module', 'custom-part', 'layout', 'venue']],
  [/^\/api\/(catalog|moderation)\b/, ['catalog']],
  [/^\/api\/(orgs|org-invites)\b/, ['club']],
  [/^\/api\/admin\/(users|orgs)\/[^/]+\/limits$/, ['limits', 'admin']],
  [/^\/api\/admin\/limits\b/, ['limits']],
  [/^\/api\/admin\/orgs\b/, ['admin', 'club']],
  [/^\/api\/admin\/layouts\b/, ['admin', 'layout']],
  [/^\/api\/admin\/users\b/, ['admin']],
  [/^\/api\/admin\/privacy\b/, ['admin']],
  [/^\/api\/admin\/(global-parts|part-libraries|reload-parts)\b/, ['parts-library']],
  [/^\/api\/admin\/settings\b/, ['settings']],
  [/^\/api\/admin\/demo\b/, ['admin', 'settings']],
];

/** Deleting one of these by its own address: DELETE /api/<kind>s/<id>. */
const DELETE_ONE = /^\/api\/(layouts|modules|venues|custom-parts)\/([^/]+)$/;

export function hintsForWrite(method: string, rawPath: string): Hint[] {
  if (method === 'GET' || method === 'HEAD') return [];
  const path = rawPath.split('?')[0] ?? '';
  // This tab deleted it: its own queries aren't asked again (see refetchKey).
  const deleted = method === 'DELETE' ? DELETE_ONE.exec(path)?.[2] : undefined;
  for (const [re, kinds] of WRITE_RULES) {
    if (re.test(path)) return kinds.map((kind): Hint => (deleted ? { kind, action: 'delete', id: decodeURIComponent(deleted) } : { kind, action: path }));
  }
  return [];
}
