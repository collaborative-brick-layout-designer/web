// The "what to refetch" table: every kind has keys, every query on the
// site is reachable from some kind, every write in api.ts maps to a
// kind, and the kinds match the server's.

import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { HINT_KINDS, focusKeys, hintsForWrite, invalidateFor, keysFor, refetchKey, type HintKind } from '../invalidate';
import { api } from '../../api';
import { backoffMs, createBatcher, parseHint } from '../LiveUpdates';

import serverHub from '../../../../server/src/events/hub.ts?raw';
import apiSource from '../../api.ts?raw';

// Every source file's text (not tests).
const SOURCES = Object.entries(
  import.meta.glob<string>(['../../**/*.{ts,tsx}', '!../../**/*.test.{ts,tsx}', '!../../**/test/**'], { query: '?raw', import: 'default', eager: true }),
);

const kindsOfWrite = (m: string, p: string) => hintsForWrite(m, p).map((h) => h.kind);
const prefixes = (kind: HintKind) => keysFor({ kind }).map((k) => k[0]);

describe('keysFor', () => {
  it('gives every kind something to refetch', () => {
    for (const kind of HINT_KINDS) expect(keysFor({ kind }).length, kind).toBeGreaterThan(0);
  });

  it('a module change refetches every list that shows modules', () => {
    // The editor's Module library and Insert module dialog, Home, the club page.
    expect(prefixes('module')).toEqual(expect.arrayContaining(['modules', 'module', 'module-versions', 'club-summary']));
  });

  it('club changes refetch the club, its members, and what membership shows', () => {
    expect(prefixes('club')).toEqual(expect.arrayContaining(['orgs', 'org', 'org-members', 'join-request-count', 'layouts', 'modules', 'venues']));
  });

  it('only membership and part-library changes refetch the big parts catalog', () => {
    expect(keysFor({ kind: 'club', action: 'update:invites' }).map((k) => k[0])).not.toContain('parts-catalog');
    expect(keysFor({ kind: 'club', action: 'delete:members' }).map((k) => k[0])).toContain('parts-catalog');
    expect(keysFor({ kind: 'club', action: '/api/orgs/x/part-libraries/y' }).map((k) => k[0])).toContain('parts-catalog');
  });

  it('every query on the site is refetched by some kind (or is listed here as never changing live)', () => {
    // One-off pages whose data doesn't change under the reader.
    const STATIC = new Set([
      'public-layout', 'public-layout-snapshot', 'reset-link', 'pending-link', 'invite-preview', 'module-invite-preview', 'part-invite-preview', 'org-invite-preview',
      'admin-series', 'admin-people', 'admin-health', 'admin-content', 'admin-usage',
    ]);
    const reachable = new Set(HINT_KINDS.flatMap((k) => prefixes(k)));
    const missing = new Set<string>();
    expect(SOURCES.length).toBeGreaterThan(100);
    for (const [file, text] of SOURCES) {
      for (const m of text.matchAll(/queryKey:\s*\[\s*'([a-z-]+)'/g)) {
        const key = m[1]!;
        if (!reachable.has(key) && !STATIC.has(key)) missing.add(`${key} (${file})`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  it('the focus refetch skips the parts catalog', () => {
    expect(focusKeys().map((k) => k[0])).not.toContain('parts-catalog');
    expect(focusKeys().map((k) => k[0])).toEqual(expect.arrayContaining(['layouts', 'modules', 'orgs']));
  });
});

describe('hintsForWrite', () => {
  it('maps writes to what they touch', () => {
    expect(kindsOfWrite('POST', '/api/modules')).toEqual(['module']);
    expect(kindsOfWrite('PUT', '/api/modules/m1/snapshot?note=hi')).toEqual(['module']);
    expect(kindsOfWrite('POST', '/api/modules/m1/transfer')).toEqual(['module', 'transfer']);
    expect(kindsOfWrite('POST', '/api/layouts/l1/transfer')).toEqual(['layout', 'transfer']);
    expect(kindsOfWrite('POST', '/api/transfers/tok')).toEqual(['layout', 'transfer']);
    expect(kindsOfWrite('DELETE', '/api/layouts/l1/collaborators/u1')).toEqual(['layout']);
    expect(kindsOfWrite('POST', '/api/orgs/club/join')).toEqual(['club']);
    expect(kindsOfWrite('POST', '/api/org-invites/tok')).toEqual(['club']);
    expect(kindsOfWrite('POST', '/api/catalog/items/i1/add')).toEqual(['catalog', 'module', 'custom-part', 'layout', 'venue']);
    expect(kindsOfWrite('POST', '/api/moderation/versions/v1/approve')).toEqual(['catalog']);
    expect(kindsOfWrite('PUT', '/api/admin/users/u1/limits')).toEqual(['limits', 'admin']);
    expect(kindsOfWrite('PATCH', '/api/admin/settings')).toEqual(['settings']);
    expect(kindsOfWrite('POST', '/api/admin/part-libraries/download')).toEqual(['parts-library']);
    expect(kindsOfWrite('PUT', '/api/me/preferences')).toEqual(['me']);
  });

  it('reads and beacons refetch nothing', () => {
    expect(kindsOfWrite('GET', '/api/modules')).toEqual([]);
    expect(kindsOfWrite('POST', '/api/metrics/client')).toEqual([]);
    expect(kindsOfWrite('POST', '/api/layouts/l1/compare')).toEqual([]);
  });

  it('every write path in api.ts maps to something', () => {
    const api = apiSource;
    const NOTHING = new Set(['/api/metrics/client', '/api/auth/password/resend-verification', '/api/auth/device/lookup', '/api/layouts/x/compare']);
    const paths = new Set<string>();
    for (const m of api.matchAll(/\b(post|put|patch|del|putBytes|apiSend)(?:<[^>]*>)?\(\s*(?:'(?:PATCH|PUT|POST)',\s*)?[`']([^`']+)[`']/g)) {
      paths.add(m[2]!.replace(/\$\{[^}]+\}/g, 'x').split('?')[0]!);
    }
    expect(paths.size).toBeGreaterThan(50);
    const unmapped = [...paths].filter((p) => p.startsWith('/api/') && !NOTHING.has(p) && hintsForWrite('POST', p).length === 0);
    expect(unmapped).toEqual([]);
  });
});

describe('the kinds match the server', () => {
  it('apps/server/src/events/hub.ts HINT_KINDS is the same list', () => {
    const hub = serverHub;
    const block = /HINT_KINDS = \[([^\]]+)\]/.exec(hub)?.[1] ?? '';
    const server = [...block.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect(server).toEqual([...HINT_KINDS]);
  });
});

describe('invalidateFor', () => {
  it('invalidates every key of the kind', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await invalidateFor(qc, 'module');
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey[0])).toEqual(prefixes('module'));
  });
});

describe('the parts catalog refetch', () => {
  it('always asks the server again, so a new or renamed set is never hidden by the browser cache', async () => {
    const fetchMock = vi.fn(async () => new Response('{"parts":[]}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const cacheOf = () => ((fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit])[1] ?? {}).cache;
    try {
      // The first read after a page load, as after a reload…
      await api.parts.catalog();
      expect(cacheOf()).toBe('no-cache');
      // …and a refetch after a change.
      await refetchKey(new QueryClient(), ['parts-catalog']);
      await api.parts.catalog();
      expect(cacheOf()).toBe('no-cache');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('live stream helpers', () => {
  it('parseHint keeps only well-formed hints', () => {
    expect(parseHint('{"kind":"module","owner":{"kind":"org","id":"o1"},"id":"m1","action":"create"}')).toEqual({
      kind: 'module', owner: { kind: 'org', id: 'o1' }, id: 'm1', action: 'create',
    });
    expect(parseHint('{"kind":"nope"}')).toBeNull();
    expect(parseHint('not json')).toBeNull();
    expect(parseHint('{"kind":"layout","owner":{"kind":"x","id":1}}')).toEqual({ kind: 'layout' });
  });

  it('backs off 1, 2, 4 … up to 30 seconds', () => {
    expect(backoffMs(0, 0.5)).toBe(1000);
    expect(backoffMs(3, 0.5)).toBe(8000);
    expect(backoffMs(10, 0.5)).toBe(30_000);
    expect(backoffMs(0, 0)).toBe(800);
  });

  it('hints that arrive together refetch each key once', () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const b = createBatcher(qc, 100);
    b.add({ kind: 'module' });
    b.add({ kind: 'module' });
    b.add({ kind: 'venue' });
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('["modules"]');
    expect(keys).toContain('["venues"]');
    vi.useRealTimers();
  });

  it('a deleted thing\'s own queries are not asked again (a 404), the lists are', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    const fetched: string[] = [];
    for (const key of [['layout', 'gone-1'], ['layout', 'kept-2'], ['layouts']]) {
      qc.getQueryCache().build(qc, { queryKey: key, queryFn: () => fetched.push(JSON.stringify(key)) });
      qc.setQueryData(key, 1);
    }
    const watch = (key: string[]) => qc.getQueryCache().find({ queryKey: key })!.state.isInvalidated;
    const b = createBatcher(qc, 100);
    b.add({ kind: 'layout', id: 'gone-1', action: 'delete' });
    vi.advanceTimersByTime(100);
    expect(watch(['layout', 'gone-1'])).toBe(false);
    expect(watch(['layout', 'kept-2'])).toBe(true);
    expect(watch(['layouts'])).toBe(true);
    vi.useRealTimers();
  });

  it('this tab\'s own delete names what it deleted', () => {
    expect(hintsForWrite('DELETE', '/api/layouts/L1')).toEqual([{ kind: 'layout', action: 'delete', id: 'L1' }]);
    expect(hintsForWrite('DELETE', '/api/modules/M1')).toEqual([{ kind: 'module', action: 'delete', id: 'M1' }]);
    expect(hintsForWrite('DELETE', '/api/layouts/L1/public-share')[0]).toEqual({ kind: 'layout', action: '/api/layouts/L1/public-share' });
  });
});
