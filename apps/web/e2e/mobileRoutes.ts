// Every page on a phone or tablet: at 360×740, iPhone 14 (390×844),
// Pixel 7 (412×915), iPad mini, iPad Air, iPad Pro 12.9, an Android
// tablet (800×1280), upright and on its side, and iPad split view, each route in main.tsx must
//   - not scroll sideways (nothing sticks out past the right edge), and
//   - give every control a tap target of at least 44×44 px.
// "Every control" means buttons, links styled as controls, tabs, radios,
// switches, menu items, form fields and checkboxes (measured with their
// label). Links inside running text are exempt, as WCAG 2.5.8 allows.
//
// SHOTS_DIR=<dir> saves one screenshot per route and device.
// MOBILE_SURVEY=<file> writes every finding to a JSON file instead of failing.
//
// The devices are split over test/mobileRoutes.*.spec.ts (phones, iPads,
// large tablets), so no one spec takes a nightly shard to itself.

import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureUser, signIn } from './helpers';
import { makeGlobalAdmin } from './dbHelpers';
import { DEVICES, findOverflow, findSmallTargets } from './mobileChecks';

const SHOTS = process.env.SHOTS_DIR;
const SURVEY = process.env.MOBILE_SURVEY;

const FORDYCE_BBM = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../packages/bbm/tests/fixtures/fordyce-2026.bbm'),
  'utf-8',
);

// MOBILE_DEVICES=<regex> runs only the matching devices.
const PICK = process.env.MOBILE_DEVICES ? new RegExp(process.env.MOBILE_DEVICES) : null;

interface Seed {
  layoutId: string;
  orgSlug: string;
  venueId: string;
  shareToken: string;
  inviteToken: string;
  orgInviteToken: string;
  transferToken: string;
}

type Who = 'owner' | 'member' | 'viewer' | 'nobody';
interface RouteCase {
  name: string;
  who: Who;
  path: (s: Seed) => string;
  /** Something that shows once the page has drawn. */
  ready?: (page: Page) => Promise<void>;
  /** A tab to open once the page is up (the admin pages keep their tabs out of the URL). */
  tab?: (page: Page) => Promise<void>;
  /** Set up before the page loads (e.g. a stubbed API answer). */
  before?: (page: Page) => Promise<void>;
}

// The server says it was updated after the page loaded: the "new version"
// bar shows (SiteVersionBar asks again when the window gets the focus).
const serverVersion = new WeakMap<Page, { v: string }>();
const newVersion = async (page: Page) => {
  const now = { v: '1.0.0' };
  serverVersion.set(page, now);
  await page.route('**/api/version', (r) => r.fulfill({ json: { version: now.v } }));
};
const versionBar = (ready?: (page: Page) => Promise<void>) => async (page: Page) => {
  if (ready) await ready(page);
  // The page has asked once (at 1.0.0); the server moves on.
  await page.waitForLoadState('networkidle').catch(() => {});
  serverVersion.get(page)!.v = '1.0.1';
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    return page.getByTestId('site-version-bar').isVisible();
  }).toBe(true);
};

// The admin sections: a list down the side, or one "Section" picker on a phone.
const adminTab = (key: string) => async (page: Page) => {
  await page.getByRole('main').waitFor();
  const pick = page.getByRole('combobox', { name: 'Section' });
  if (await pick.isVisible()) await pick.selectOption(key);
  else await page.getByRole('navigation', { name: 'Admin sections' }).locator(`a[href="/admin?tab=${key}"]`).click();
};
const clubTab = (name: string) => async (page: Page) => {
  await page.getByRole('tab', { name, exact: true }).click();
};

const canvasReady = async (page: Page) => {
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
};

const ROUTES: RouteCase[] = [
  { name: 'home', who: 'owner', path: () => '/', ready: (p) => expect(p.getByText('Mobile Layout').first()).toBeVisible() },
  { name: 'home-signed-out', who: 'nobody', path: () => '/' },
  { name: 'login', who: 'nobody', path: () => '/login' },
  { name: 'help', who: 'owner', path: () => '/help' },
  { name: 'profile', who: 'owner', path: () => '/profile' },
  { name: 'link', who: 'owner', path: () => '/link' },
  { name: 'device', who: 'owner', path: () => '/device' },
  { name: 'invite', who: 'member', path: (s) => `/invite/${s.inviteToken}` },
  { name: 'verify-email', who: 'nobody', path: () => '/verify-email/not-a-real-token' },
  { name: 'reset-password', who: 'nobody', path: () => '/reset-password/not-a-real-token' },
  { name: 'transfer', who: 'member', path: (s) => `/transfer/${s.transferToken}` },
  { name: 'org-invite', who: 'member', path: (s) => `/org-invite/${s.orgInviteToken}` },
  { name: 'orgs', who: 'owner', path: () => '/orgs' },
  { name: 'org', who: 'owner', path: (s) => `/orgs/${s.orgSlug}` },
  { name: 'org-admin', who: 'owner', path: (s) => `/orgs/${s.orgSlug}/admin` },
  // The old Library page now lands on the home page's Custom parts.
  { name: 'library-to-parts', who: 'owner', path: () => '/library' },
  { name: 'editor-owner', who: 'owner', path: (s) => `/editor/${s.layoutId}`, ready: canvasReady },
  { name: 'editor-viewer', who: 'viewer', path: (s) => `/editor/${s.layoutId}`, ready: canvasReady },
  { name: 'venue-new', who: 'owner', path: () => '/venues/new' },
  { name: 'venue-design', who: 'owner', path: (s) => `/venues/${s.venueId}/design` },
  { name: 'admin', who: 'owner', path: () => '/admin', ready: (p) => expect(p.getByRole('heading', { name: 'Needs attention' })).toBeVisible() },
  ...([['heavy-use', 'heavy'], ['users', 'users'], ['clubs', 'orgs'], ['layouts', 'layouts'], ['parts', 'parts'], ['libraries', 'libraries'], ['audit', 'audit'], ['settings', 'settings']] as const).map(([n, key]): RouteCase => ({
    name: `admin-${n}`, who: 'owner', path: () => '/admin', tab: adminTab(key),
  })),
  { name: 'new-version-bar', who: 'owner', path: () => '/', before: newVersion, ready: versionBar() },
  { name: 'new-version-bar-editor', who: 'owner', path: (s) => `/editor/${s.layoutId}`, before: newVersion, ready: versionBar(canvasReady) },
  ...['Settings', 'Parts', 'Activity'].map((t): RouteCase => ({
    name: `org-admin-${t.toLowerCase()}`, who: 'owner', path: (s) => `/orgs/${s.orgSlug}/admin`, tab: clubTab(t),
  })),
  { name: 'about', who: 'owner', path: () => '/about' },
  { name: 'settings', who: 'owner', path: () => '/settings' },
  { name: 'public-layout', who: 'nobody', path: (s) => `/p/${s.shareToken}`, ready: canvasReady },
];

/** Every route on the devices whose names `group` takes (and MOBILE_DEVICES, if set). */
export function mobileRouteTests(group: (device: string) => boolean): void {
  const PHONES = DEVICES.filter((d) => group(d.name) && (!PICK || PICK.test(d.name)));
  const ts = Date.now();
  const OWNER = `mobile-owner-${ts}@example.com`;
  const MEMBER = `mobile-member-${ts}@example.com`;
  const VIEWER = `mobile-viewer-${ts}@example.com`;
  let seed: Seed;

  test.beforeAll(async ({ baseURL }) => {
    test.setTimeout(120_000);
    const ownerCookies = await ensureUser(OWNER, 'Mobile Owner');
    await ensureUser(MEMBER, 'Mobile Member');
    const viewerCookies = await ensureUser(VIEWER, 'Mobile Viewer');
    makeGlobalAdmin(OWNER);
    const api = await playwrightRequest.newContext({ baseURL, storageState: { cookies: ownerCookies, origins: [] } });
    const post = async <T,>(path: string, data: unknown = {}): Promise<T> => {
      const res = await api.post(path, { data });
      expect(res.ok(), `${path}: ${res.status()} ${await res.text()}`).toBe(true);
      return (await res.json()) as T;
    };
    try {
      const { id: layoutId } = await post<{ id: string }>('/api/layouts', { title: 'Mobile Layout', bbm: FORDYCE_BBM });
      // A second layout so the home page has a list, one with a long name.
      await post('/api/layouts', { title: 'A layout with a rather long name for a small phone screen' });
      const org = await post<{ slug: string }>('/api/orgs', { name: `Mobile Club ${ts}` });
      const venue = await post<{ id: string }>('/api/venues', {
        name: 'Mobile Hall',
        data: { name: 'Mobile Hall', enabled: true, minWalkwayStuds: 0, bounds: { x: 0, y: 0, w: 0, h: 0 }, edges: [], obstacles: [] },
      });
      const { token: shareToken } = await post<{ token: string }>(`/api/layouts/${layoutId}/public-share`);
      const { token: inviteToken } = await post<{ token: string }>(`/api/layouts/${layoutId}/invites`, { email: MEMBER, role: 'editor' });
      const { token: orgInviteToken } = await post<{ token: string }>(`/api/orgs/${org.slug}/invites`, { email: MEMBER, role: 'member' });
      const { id: spareId } = await post<{ id: string }>('/api/layouts', { title: 'Mobile Transfer' });
      const { token: transferToken } = await post<{ token: string }>(`/api/layouts/${spareId}/transfer`, { recipientEmail: MEMBER });
      const { token: viewerInvite } = await post<{ token: string }>(`/api/layouts/${layoutId}/invites`, { email: VIEWER, role: 'viewer' });
      const viewerApi = await playwrightRequest.newContext({ baseURL, storageState: { cookies: viewerCookies, origins: [] } });
      expect((await viewerApi.post(`/api/invites/${viewerInvite}`)).ok()).toBe(true);
      await viewerApi.dispose();
      seed = { layoutId, orgSlug: org.slug, venueId: venue.id, shareToken, inviteToken, orgInviteToken, transferToken };
    } finally {
      await api.dispose();
    }
  });

  const survey: Record<string, { overflow: string[]; small: string[] }> = {};

  for (const phone of PHONES) {
    test.describe(`on ${phone.name}`, () => {
      test.use(phone.use);
      for (const route of ROUTES) {
        test(`${route.name} fits and has 44 px tap targets`, async ({ page }) => {
          if (route.who === 'owner') await signIn(page, OWNER, 'Mobile Owner');
          if (route.who === 'member') await signIn(page, MEMBER, 'Mobile Member');
          if (route.who === 'viewer') await signIn(page, VIEWER, 'Mobile Viewer');
          if (route.before) await route.before(page);
          await page.goto(route.path(seed));
          if (route.ready) await route.ready(page);
          if (route.tab) await route.tab(page);
          await page.waitForLoadState('networkidle').catch(() => {});
          // Let lazy pages and fonts settle.
          await page.waitForTimeout(400);
          const overflow = await findOverflow(page);
          const small = await findSmallTargets(page);
          if (SHOTS) await page.screenshot({ path: `${SHOTS}/${phone.name}--${route.name}.png` });
          if (SURVEY) {
            survey[`${route.name} @ ${phone.name}`] = { overflow, small };
            return;
          }
          expect(overflow, 'nothing sticks out sideways').toEqual([]);
          expect(small, 'every control is at least 44×44 px').toEqual([]);
        });
      }
    });
  }

  test.afterAll(() => {
    if (!SURVEY) return;
    const before = existsSync(SURVEY) ? (JSON.parse(readFileSync(SURVEY, 'utf-8')) as typeof survey) : {};
    writeFileSync(SURVEY, JSON.stringify({ ...before, ...survey }, null, 2));
  });
}
