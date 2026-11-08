// The pages and dialogs added lately, on phones and tablets: 375×667,
// 390×844 and 768×1024, upright and on their side. Club Manage (People with
// join requests and last active, Roles, Settings with the logo, Parts,
// Activity), the custom parts and sets lists, the share dialogs and invite
// pages, Save as set, the "Update available" bar, the move and copy plans,
// Admin › Heavy use and the new-version bar. Each must
//   - not scroll sideways (nothing sticks out past the right edge),
//   - fit a dialog inside the screen (a taller one scrolls inside itself),
//   - keep bars that stay put from covering what's under them, and
//   - give every control a tap target of at least 44×44 px.
//
// SHOTS_DIR=<dir> saves one screenshot of each.
// MOBILE_SURVEY=<file> writes every finding to a JSON file instead of failing.

import { test, expect, devices, request as playwrightRequest, type Browser, type Page } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ensureUser, signIn, mapMenu } from '../helpers';
import { makeGlobalAdmin } from '../dbHelpers';
import { findOverflow, findSmallTargets } from '../mobileChecks';

const SHOTS = process.env.SHOTS_DIR;
const SURVEY = process.env.MOBILE_SURVEY;

const { defaultBrowserType: _a, ...iPhone14 } = devices['iPhone 14'];
const { defaultBrowserType: _b, ...iPadMini } = devices['iPad Mini'];
const size = (width: number, height: number) => ({ viewport: { width, height }, screen: { width, height } });
const SIZES = [
  { name: '375x667', kind: 'phone', use: { ...iPhone14, ...size(375, 667) } },
  { name: '667x375', kind: 'phone', use: { ...iPhone14, ...size(667, 375) } },
  { name: '390x844', kind: 'phone', use: { ...iPhone14, ...size(390, 844) } },
  { name: '844x390', kind: 'phone', use: { ...iPhone14, ...size(844, 390) } },
  { name: '768x1024', kind: 'tablet', use: { ...iPadMini, ...size(768, 1024) } },
  { name: '1024x768', kind: 'tablet', use: { ...iPadMini, ...size(1024, 768) } },
] as const;
const PICK = process.env.MOBILE_DEVICES ? new RegExp(process.env.MOBILE_DEVICES) : null;

const ts = Date.now();
const OWNER = `newpages-owner-${ts}@example.com`;
const ASKER = `newpages-asker-${ts}@example.com`;
const MEMBER = `newpages-member-${ts}@example.com`;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const XML = Buffer.from('<?xml version="1.0"?><part><Author>e2e</Author></part>').toString('base64');
const SHED = `SHED${ts}`;
const LAMP = `LAMP${ts}`;
// Long names, the way people name things.
const SET = `Engine yard with turntable ${ts}`;
const CLUB = `Northern Lines Model Railway Club ${ts}`;
const setXml = (ids: string[]) =>
  Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>\n<group>\n\t<Description><en>${SET}</en></Description>\n\t<SubPartList>\n` +
      ids.map((id, i) => `\t\t<SubPart id="${id}"><position><x>${i * 8}</x><y>0</y></position><angle>0</angle></SubPart>\n`).join('') +
      '\t</SubPartList>\n</group>\n',
  ).toString('base64');

interface Seed {
  orgSlug: string;
  layoutId: string;
  partInvite: string;
  moduleInvite: string;
}
let seed: Seed;

/** Places the set in a new layout at a desktop size, then changes the set: the layout offers an update. */
async function layoutWithStaleSet(browser: Browser, setId: string): Promise<string> {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, hasTouch: false, isMobile: false, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  try {
    await signIn(page, OWNER, 'Owner');
    const layout = (await (await page.request.post('/api/layouts', { data: { title: 'Set yard layout' } })).json()) as { id: string };
    await page.goto(`/editor/${layout.id}`);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('html')).toHaveAttribute('data-live', 'open', { timeout: 15000 });
    await page.getByPlaceholder('Search parts (name or number)').first().fill(SET);
    // The tile's name is cut short.
    const tile = page.locator('aside li button[draggable="true"]').filter({ hasText: 'Engine yard with' }).first();
    await expect(tile).toBeVisible({ timeout: 15000 });
    await tile.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('footer')).toContainText(`Placed set: ${SET}`);
    const put = await page.request.put(`/api/custom-parts/${setId}`, { data: { partNumber: SET, displayName: SET, xmlBase64: setXml([SHED, LAMP, LAMP]) } });
    expect(put.ok()).toBe(true);
    await expect(page.getByTestId('set-updates')).toBeVisible({ timeout: 15000 });
    // Saved before the page goes.
    await expect
      .poll(async () => [...(await (await page.request.get(`/api/layouts/${layout.id}/export.bbm`)).text()).matchAll(/<Brick id="/g)].length, { timeout: 15000 })
      .toBe(2);
    return layout.id;
  } finally {
    await ctx.close();
  }
}

test.beforeAll(async ({ baseURL, browser }) => {
  test.setTimeout(180_000);
  const ownerCookies = await ensureUser(OWNER, 'Owner');
  const askerCookies = await ensureUser(ASKER, 'Asker With A Rather Long Display Name');
  const memberCookies = await ensureUser(MEMBER, 'Member');
  makeGlobalAdmin(OWNER);
  const as = (cookies: typeof ownerCookies) => playwrightRequest.newContext({ baseURL, storageState: { cookies, origins: [] } });
  const api = await as(ownerCookies);
  const post = async <T,>(path: string, data: unknown = {}, method: 'post' | 'patch' | 'put' = 'post'): Promise<T> => {
    const res = await api[method](path, { data });
    expect(res.ok(), `${path}: ${res.status()} ${await res.text()}`).toBe(true);
    return (await res.json()) as T;
  };
  try {
    const org = await post<{ slug: string }>('/api/orgs', { name: CLUB });
    await post(`/api/orgs/${org.slug}`, { joinPolicy: 'request', listed: true }, 'patch');
    await post(`/api/orgs/${org.slug}/logo`, { mime: 'image/png', data: PNG }, 'put');
    // A member (so People lists someone with a last-active time) and someone asking to join.
    const { token } = await post<{ token: string }>(`/api/orgs/${org.slug}/invites`, { email: MEMBER, role: 'member' });
    const member = await as(memberCookies);
    expect((await member.post(`/api/org-invites/${token}`)).ok()).toBe(true);
    await member.dispose();
    const asker = await as(askerCookies);
    const asked = await asker.post(`/api/orgs/${org.slug}/join`, { data: { message: 'Hello! I build trains and would love to bring my modules to your next show.' } });
    expect(asked.ok(), await asked.text()).toBe(true);
    await asker.dispose();

    for (const [n, name] of [[SHED, 'Engine shed with a very long name'], [LAMP, 'Yard lamp']]) {
      await post('/api/custom-parts', { partNumber: n, displayName: name, xmlBase64: XML, spriteBase64: PNG, spriteMime: 'image/png' });
    }
    const set = await post<{ id: string }>('/api/custom-parts', { partNumber: SET, displayName: SET, xmlBase64: setXml([SHED, LAMP]) });
    await post('/api/modules', { title: 'Station module' });
    const { token: partInvite } = await post<{ token: string }>(`/api/custom-parts/${set.id}/invites`, { email: MEMBER, role: 'viewer' });
    const mod = await post<{ id: string }>('/api/modules', { title: 'Shared module' });
    const { token: moduleInvite } = await post<{ token: string }>(`/api/modules/${mod.id}/invites`, { email: MEMBER, role: 'viewer' });
    const layoutId = await layoutWithStaleSet(browser, set.id);
    seed = { orgSlug: org.slug, layoutId, partInvite, moduleInvite };
  } finally {
    await api.dispose();
  }
});

const clubTab = (name: string) => async (page: Page) => {
  await page.getByRole('tab', { name, exact: false }).first().click();
};
const adminTab = (key: string) => async (page: Page) => {
  await page.getByRole('main').waitFor();
  const pick = page.getByRole('combobox', { name: 'Section' });
  if (await pick.isVisible()) await pick.selectOption(key);
  else await page.getByRole('navigation', { name: 'Admin sections' }).locator(`a[href="/admin?tab=${key}"]`).click();
};
const canvasReady = async (page: Page) => {
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
};
const partsReady = (page: Page) => expect(page.getByRole('button', { name: `More for ${SET}` })).toBeVisible({ timeout: 15000 });

interface Case {
  name: string;
  who: 'owner' | 'member' | 'nobody';
  path: (s: Seed) => string;
  ready?: (page: Page) => Promise<void>;
  /** Opens the dialog to check (otherwise the whole page is checked). */
  open?: (page: Page) => Promise<void>;
  on?: 'phone' | 'tablet';
  before?: (page: Page) => Promise<void>;
}

const more = (title: string, item?: string) => async (page: Page) => {
  await page.getByRole('button', { name: `More for ${title}` }).click();
  if (item) await page.getByRole('menuitem', { name: item }).click();
};
const club = (s: Seed) => `/orgs/${s.orgSlug}/admin`;
const editor = (s: Seed) => `/editor/${s.layoutId}`;

// The server says it was updated after the page loaded: the version bar shows.
const serverVersion = new WeakMap<Page, { v: string }>();
const newVersion = async (page: Page) => {
  const now = { v: '1.0.0' };
  serverVersion.set(page, now);
  await page.route('**/api/version', (r) => r.fulfill({ json: { version: now.v } }));
};
const versionBar = (ready?: (page: Page) => Promise<void>) => async (page: Page) => {
  if (ready) await ready(page);
  await page.waitForLoadState('networkidle').catch(() => {});
  serverVersion.get(page)!.v = '1.0.1';
  await expect.poll(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    return page.getByTestId('site-version-bar').isVisible();
  }).toBe(true);
};

const CASES: Case[] = [
  { name: 'club people', who: 'owner', path: club, ready: (p) => expect(p.getByText('Hello! I build trains').first()).toBeVisible() },
  { name: 'club roles', who: 'owner', path: club, open: undefined, ready: clubTab('Roles') },
  { name: 'club settings', who: 'owner', path: club, ready: clubTab('Settings') },
  { name: 'club parts', who: 'owner', path: club, ready: clubTab('Parts') },
  { name: 'club activity', who: 'owner', path: club, ready: clubTab('Activity') },
  { name: 'custom parts and sets', who: 'owner', path: () => '/#parts', ready: partsReady },
  { name: 'set row menu', who: 'owner', path: () => '/#parts', ready: partsReady, open: more(SET) },
  { name: 'set share', who: 'owner', path: () => '/#parts', ready: partsReady, open: more(SET, 'Share with people…') },
  { name: 'part share', who: 'owner', path: () => '/#parts', ready: partsReady, open: more(LAMP, 'Share with people…') },
  {
    name: 'set move plan', who: 'owner', path: () => '/#parts', ready: partsReady,
    open: async (p) => {
      await more(SET, 'Move or copy…')(p);
      await p.getByLabel(/Move to a club/).check();
      await expect(p.getByTestId('set-move-parts')).toBeVisible();
    },
  },
  {
    name: 'set copy plan', who: 'owner', path: () => '/#parts', ready: partsReady,
    open: async (p) => {
      // Copy to the club is what it starts on.
      await more(SET, 'Move or copy…')(p);
      await expect(p.getByTestId('set-move-parts')).toBeVisible();
    },
  },
  { name: 'module share', who: 'owner', path: () => '/', ready: (p) => expect(p.getByText('Station module').first()).toBeVisible(), open: more('Station module', 'Share with people…') },
  { name: 'part invite signed out', who: 'nobody', path: (s) => `/part-invite/${s.partInvite}` },
  { name: 'module invite signed out', who: 'nobody', path: (s) => `/module-invite/${s.moduleInvite}` },
  { name: 'admin heavy use', who: 'owner', path: () => '/admin', ready: adminTab('heavy') },
  { name: 'version bar', who: 'owner', path: () => '/', before: newVersion, ready: versionBar() },
  { name: 'version bar editor', who: 'owner', path: editor, before: newVersion, ready: versionBar(canvasReady) },
  {
    name: 'update available bar', who: 'owner', path: editor,
    ready: async (p) => {
      await canvasReady(p);
      // A phone opens in View; the bar is for editing.
      const sw = p.getByTestId('mode-switch');
      if (await sw.isVisible()) await sw.getByRole('radio', { name: 'Edit' }).click();
      await expect(p.getByTestId('set-updates')).toBeVisible({ timeout: 15000 });
    },
  },
  {
    // Saving a set is for a tablet or a computer: a phone has no Map menu.
    name: 'save as set', who: 'owner', path: editor, on: 'tablet',
    ready: canvasReady,
    open: async (p) => {
      const sw = p.getByTestId('mode-switch');
      if (await sw.isVisible()) await sw.getByRole('radio', { name: 'Edit' }).click();
      await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await p.keyboard.press('Control+a');
      await mapMenu(p, 'Modules & sets', 'Save selection as set…');
    },
  },
];

/** Bars that stay put (fixed or sticky) that cover a control under them. */
function findCovered(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const bars = [...document.querySelectorAll<HTMLElement>('[data-testid=site-version-bar], [data-testid=set-updates]')];
    for (const bar of bars) {
      const r = bar.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      for (const el of document.querySelectorAll<HTMLElement>('button, a[href], [role=tab], input, select')) {
        if (bar.contains(el) || el.closest('[aria-hidden=true]')) continue;
        const e = el.getBoundingClientRect();
        if (!e.width || !e.height) continue;
        const cx = e.left + e.width / 2;
        const cy = e.top + e.height / 2;
        if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
        // Scrolled out of its box (a list that scrolls), not under the bar.
        let clipped = false;
        for (let p = el.parentElement; p && !clipped; p = p.parentElement) {
          if (getComputedStyle(p).overflowY === 'visible') continue;
          const b = p.getBoundingClientRect();
          clipped = cy < b.top || cy > b.bottom || cx < b.left || cx > b.right;
        }
        if (clipped) continue;
        const top = document.elementFromPoint(cx, cy);
        if (top && bar.contains(top)) out.push(`${bar.dataset.testid} covers "${(el.getAttribute('aria-label') ?? el.innerText ?? '').trim().slice(0, 30)}"`);
      }
    }
    return out;
  });
}

const survey: Record<string, { overflow: string[]; small: string[]; fit: string[]; covered: string[] }> = {};

for (const dev of SIZES.filter((d) => !PICK || PICK.test(d.name))) {
  test.describe(`on ${dev.name}`, () => {
    test.use(dev.use);
    for (const c of CASES.filter((x) => !x.on || x.on === dev.kind)) {
      test(`${c.name} fits and is easy to tap`, async ({ page }) => {
        if (c.who === 'owner') await signIn(page, OWNER, 'Owner');
        if (c.who === 'member') await signIn(page, MEMBER, 'Member');
        if (c.before) await c.before(page);
        await page.goto(c.path(seed));
        if (c.ready) await c.ready(page);
        let scope = 'body';
        const fit: string[] = [];
        if (c.open) {
          await c.open(page);
          const top = page.locator('[role=dialog]:visible, [role=menu]:visible').last();
          await expect(top).toBeVisible();
          await page.waitForTimeout(250);
          await top.evaluate((el) => el.setAttribute('data-check', 'top'));
          scope = '[data-check="top"]';
          const box = (await top.boundingBox())!;
          const vp = page.viewportSize()!;
          const scrolls = await top.evaluate((el) => {
            for (let e: Element | null = el; e; e = e.parentElement) {
              const oy = getComputedStyle(e).overflowY;
              if ((oy === 'auto' || oy === 'scroll') && e.clientHeight <= window.innerHeight + 1) return true;
            }
            return false;
          });
          if (box.x < -1 || box.x + box.width > vp.width + 1) fit.push(`off the side (${Math.round(box.x)}..${Math.round(box.x + box.width)})`);
          if ((box.height > vp.height + 1 || box.y < -1) && !scrolls) fit.push(`taller than the screen and doesn't scroll (${Math.round(box.height)} px)`);
        }
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(400);
        const overflow = await findOverflow(page, scope);
        const small = await findSmallTargets(page, scope);
        const covered = c.open ? [] : await findCovered(page);
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/${dev.name}--${c.name.replace(/\W+/g, '-')}.png`, fullPage: !c.open });
        if (SURVEY) {
          survey[`${c.name} @ ${dev.name}`] = { overflow, small, fit, covered };
          return;
        }
        expect(fit, 'the dialog fits the screen').toEqual([]);
        expect(overflow, 'nothing sticks out sideways').toEqual([]);
        expect(small, 'every control is at least 44×44 px').toEqual([]);
        expect(covered, 'no bar covers a control').toEqual([]);
      });
    }
  });
}

test.afterAll(() => {
  if (!SURVEY) return;
  const before = existsSync(SURVEY) ? (JSON.parse(readFileSync(SURVEY, 'utf-8')) as typeof survey) : {};
  writeFileSync(SURVEY, JSON.stringify({ ...before, ...survey }, null, 2));
});
