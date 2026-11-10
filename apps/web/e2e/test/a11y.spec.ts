// Accessibility, page by page and dialog by dialog, in the light theme and
// the dark one: axe finds nothing wrong (labels, roles, names, contrast),
// and each dialog works from the keyboard alone: it takes the focus when it
// opens, Tab goes round its controls without wandering off behind it, Escape
// closes it, and the focus goes back to the button that opened it.
//
// A11Y_SURVEY=<file> writes every finding to a JSON file instead of failing.

import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ensureUser, signIn, mapMenu } from '../helpers';
import { makeGlobalAdmin } from '../dbHelpers';
import { axeProblems } from '../a11y';
import { mapMenuDialogPaths } from '../../src/editor/mapMenuDialogs';

const SURVEY = process.env.A11Y_SURVEY;
const ts = Date.now();
const OWNER = `a11y-owner-${ts}@example.com`;
const ASKER = `a11y-asker-${ts}@example.com`;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const XML = Buffer.from('<?xml version="1.0"?><part><Author>e2e</Author></part>').toString('base64');
const SHED = `ASHED${ts}`;
const SET = `A11y yard ${ts}`;
const setXml = Buffer.from(
  `<?xml version="1.0" encoding="utf-8"?>\n<group>\n\t<Description><en>${SET}</en></Description>\n\t<SubPartList>\n` +
    `\t\t<SubPart id="${SHED}"><position><x>0</x><y>0</y></position><angle>0</angle></SubPart>\n` +
    `\t\t<SubPart id="3001.1"><position><x>8</x><y>0</y></position><angle>0</angle></SubPart>\n` +
    '\t</SubPartList>\n</group>\n',
).toString('base64');

let slug = '';
let layoutId = '';

test.beforeAll(async ({ baseURL }) => {
  test.setTimeout(120_000);
  const cookies = await ensureUser(OWNER, 'Ada Owner');
  const askerCookies = await ensureUser(ASKER, 'Ben Asker');
  makeGlobalAdmin(OWNER);
  const api = await playwrightRequest.newContext({ baseURL, storageState: { cookies, origins: [] } });
  const ok = async <T,>(p: Promise<import('@playwright/test').APIResponse>): Promise<T> => {
    const r = await p;
    expect(r.ok(), `${r.url()}: ${r.status()} ${await r.text()}`).toBe(true);
    return (await r.json()) as T;
  };
  try {
    const org = await ok<{ slug: string }>(api.post('/api/orgs', { data: { name: `A11y Club ${ts}` } }));
    slug = org.slug;
    await ok(api.patch(`/api/orgs/${slug}`, { data: { joinPolicy: 'request', listed: true } }));
    const asker = await playwrightRequest.newContext({ baseURL, storageState: { cookies: askerCookies, origins: [] } });
    await ok(asker.post(`/api/orgs/${slug}/join`, { data: { message: 'Hi! May I join?' } }));
    await asker.dispose();
    layoutId = (await ok<{ id: string }>(api.post('/api/layouts', { data: { title: 'A11y Layout' } }))).id;
    await ok(api.post('/api/modules', { data: { title: 'A11y Module' } }));
    await ok(api.post('/api/custom-parts', { data: { partNumber: SHED, displayName: 'Engine shed', xmlBase64: XML, spriteBase64: PNG, spriteMime: 'image/png' } }));
    await ok(api.post('/api/custom-parts', { data: { partNumber: SET, displayName: SET, xmlBase64: setXml } }));
  } finally {
    await api.dispose();
  }
});

const adminTab = (key: string) => async (page: Page) => {
  await page.getByRole('navigation', { name: 'Admin sections' }).locator(`a[href="/admin?tab=${key}"]`).click();
  await page.waitForLoadState('networkidle').catch(() => {});
};
const clubTab = (name: string) => async (page: Page) => {
  await page.getByRole('tab', { name, exact: false }).first().click();
};
const editorReady = async (page: Page) => {
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('loading-card')).toBeHidden({ timeout: 20000 });
};
const homeReady = (page: Page) => expect(page.getByText('A11y Layout').first()).toBeVisible();

interface PageCase {
  name: string;
  signedIn: boolean;
  path: () => string;
  ready?: (page: Page) => Promise<void>;
}
const PAGES: PageCase[] = [
  { name: 'home signed out', signedIn: false, path: () => '/' },
  { name: 'sign in', signedIn: false, path: () => '/login' },
  { name: 'home', signedIn: true, path: () => '/', ready: homeReady },
  { name: 'custom parts', signedIn: true, path: () => '/#parts', ready: (p) => expect(p.getByRole('button', { name: `More for ${SET}` })).toBeVisible() },
  { name: 'clubs', signedIn: true, path: () => '/orgs' },
  { name: 'club', signedIn: true, path: () => `/orgs/${slug}` },
  { name: 'club manage people', signedIn: true, path: () => `/orgs/${slug}/admin`, ready: (p) => expect(p.getByText('Hi! May I join?')).toBeVisible() },
  { name: 'club manage roles', signedIn: true, path: () => `/orgs/${slug}/admin`, ready: clubTab('Roles') },
  { name: 'club manage settings', signedIn: true, path: () => `/orgs/${slug}/admin`, ready: clubTab('Settings') },
  { name: 'club manage parts', signedIn: true, path: () => `/orgs/${slug}/admin`, ready: clubTab('Parts') },
  { name: 'club manage activity', signedIn: true, path: () => `/orgs/${slug}/admin`, ready: clubTab('Activity') },
  { name: 'settings', signedIn: true, path: () => '/settings' },
  { name: 'profile', signedIn: true, path: () => '/profile' },
  { name: 'help', signedIn: true, path: () => '/help' },
  { name: 'about', signedIn: true, path: () => '/about' },
  { name: 'catalog', signedIn: true, path: () => '/catalog' },
  { name: 'notices', signedIn: true, path: () => '/notices' },
  { name: 'admin', signedIn: true, path: () => '/admin', ready: (p) => expect(p.getByRole('heading', { name: 'Needs attention' })).toBeVisible() },
  { name: 'admin heavy use', signedIn: true, path: () => '/admin', ready: adminTab('heavy') },
  { name: 'admin users', signedIn: true, path: () => '/admin', ready: adminTab('users') },
  { name: 'admin settings', signedIn: true, path: () => '/admin', ready: adminTab('settings') },
  { name: 'editor', signedIn: true, path: () => `/editor/${layoutId}`, ready: editorReady },
  { name: 'new venue', signedIn: true, path: () => '/venues/new' },
];

interface DialogCase {
  name: string;
  path: () => string;
  ready: (page: Page) => Promise<void>;
  /** Opens it; returns the button that opened it (where the focus goes back to). */
  open: (page: Page) => Promise<void>;
  /** The dialog's accessible name; unset: the newest dialog on the page. */
  dialog?: string | RegExp;
  /** Escape and the focus going back are checked (off for one opened from a menu that closes). */
  focusBack?: boolean;
  /** Stays open beside the map: the focus isn't kept inside it. */
  modeless?: boolean;
}
const more = (title: string, item: string) => async (page: Page) => {
  await page.getByRole('button', { name: `More for ${title}` }).click();
  await page.getByRole('menuitem', { name: item }).click();
};
const editor = () => `/editor/${layoutId}`;
const DIALOGS: DialogCase[] = [
  { name: 'new layout', path: () => '/', ready: homeReady, open: (p) => p.getByRole('button', { name: 'New layout' }).click(), dialog: 'New layout', focusBack: true },
  { name: 'layout share', path: () => '/', ready: homeReady, open: more('A11y Layout', 'Share…'), dialog: 'Share A11y Layout' },
  { name: 'layout move or copy', path: () => '/', ready: homeReady, open: more('A11y Layout', 'Move or copy…'), dialog: /Move or copy/ },
  { name: 'module share', path: () => '/', ready: homeReady, open: more('A11y Module', 'Share with people…'), dialog: 'Share A11y Module' },
  { name: 'set share', path: () => '/#parts', ready: (p) => expect(p.getByRole('button', { name: `More for ${SET}` })).toBeVisible(), open: more(SET, 'Share with people…'), dialog: `Share ${SET}` },
  {
    name: 'set move plan', path: () => '/#parts', ready: (p) => expect(p.getByRole('button', { name: `More for ${SET}` })).toBeVisible(),
    open: async (p) => {
      await more(SET, 'Move or copy…')(p);
      await p.getByLabel(/Move to a club/).check();
      await expect(p.getByTestId('set-move-parts')).toBeVisible();
    },
    dialog: /Move or copy/,
  },
  { name: 'add a custom part', path: () => '/#parts', ready: (p) => expect(p.getByRole('button', { name: `More for ${SET}` })).toBeVisible(), open: (p) => p.getByRole('button', { name: 'Upload part', exact: true }).click(), dialog: 'Upload custom part', focusBack: true },
  { name: 'editor share', path: editor, ready: editorReady, open: (p) => p.getByRole('button', { name: 'Share', exact: true }).click(), dialog: 'Share A11y Layout', focusBack: true },
  // Every dialog in the Map menu, read from the menu itself (mapMenuDialogs.ts).
  // Find stays open while you work on the map (modeless): Tab may leave it.
  ...mapMenuDialogPaths().map((path): DialogCase => ({
    name: `editor ${path.join(' › ').replace(/…/g, '')}`,
    path: editor,
    ready: editorReady,
    open: (p) => mapMenu(p, ...path),
    // Find and the Budget stay open beside the map (modeless).
    ...(path.at(-1) === 'Find & Replace…' ? { dialog: /Find/, modeless: true } : {}),
    ...(path.at(-1) === 'Edit budget…' ? { dialog: 'Budget', modeless: true } : {}),
  })),
  {
    name: 'editor save as set', path: editor, ready: editorReady,
    open: async (p) => {
      await p.getByPlaceholder('Search parts (name or number)').first().fill('Engine shed');
      const tile = p.locator('aside li button[draggable="true"]').filter({ hasText: 'Engine shed' }).first();
      await tile.focus();
      await p.keyboard.press('Enter');
      await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await p.keyboard.press('Control+a');
      await mapMenu(p, 'Modules & sets', 'Save selection as set…');
    },
    dialog: 'Save selection as set',
  },
];

const survey: Record<string, string[]> = {};
const record = (key: string, problems: string[]) => {
  if (SURVEY) survey[key] = problems;
  else expect(problems, `${key}: accessibility problems`).toEqual([]);
};

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 860 } });
    for (const c of PAGES) {
      test(`${c.name}: no accessibility problems`, async ({ page }) => {
        if (c.signedIn) await signIn(page, OWNER, 'Ada Owner');
        await page.goto(c.path());
        if (c.ready) await c.ready(page);
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(300);
        await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
        record(`${c.name} @ ${scheme}`, await axeProblems(page));
      });
    }
    for (const d of DIALOGS) {
      test(`${d.name} dialog: no accessibility problems, and works from the keyboard`, async ({ page }) => {
        test.setTimeout(90_000);
        await signIn(page, OWNER, 'Ada Owner');
        await page.goto(d.path());
        await d.ready(page);
        await d.open(page);
        const dialog = (d.dialog ? page.getByRole('dialog', { name: d.dialog }) : page.getByRole('dialog')).last();
        await expect(dialog).toBeVisible();
        await page.waitForTimeout(300);
        await dialog.evaluate((el) => el.setAttribute('data-a11y-check', ''));
        const problems = await axeProblems(page, { include: '[data-a11y-check]' });
        // The keyboard: the focus is inside; Tab twenty times stays inside.
        const keys: string[] = [];
        const inside = () => dialog.evaluate((el) => el.contains(document.activeElement));
        if (!(await inside())) keys.push('the focus is not in the dialog when it opens');
        for (let i = 0; i < (d.modeless ? 0 : 20); i++) {
          await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab');
          if (!(await inside())) {
            const where = await page.evaluate(() => (document.activeElement?.outerHTML ?? '').slice(0, 120));
            keys.push(`Tab ${i + 1} left the dialog, to ${where}`);
            break;
          }
        }
        // Escape closes it (from a plain spot: not a field that uses Escape itself).
        await dialog.evaluate((el) => {
          if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
          (el as HTMLElement).focus();
        });
        await page.keyboard.press('Escape');
        if (await dialog.isVisible().catch(() => false)) keys.push('Escape does not close it');
        else if (d.focusBack) {
          // Back on the button that opened it.
          const back = await page.evaluate(() => {
            const a = document.activeElement as HTMLElement | null;
            return a && a !== document.body ? (a.getAttribute('aria-label') ?? a.innerText).trim() : null;
          });
          if (!back) keys.push('the focus does not go back to the button that opened it');
        }
        record(`${d.name} dialog @ ${scheme}`, [...problems, ...keys]);
      });
    }
  });
}

test('the editor\'s Map menu works from the keyboard alone', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signIn(page, OWNER, 'Ada Owner');
  await page.goto(editor());
  await editorReady(page);
  const map = page.getByRole('button', { name: 'Map', exact: true });
  await map.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu').first();
  await expect(menu).toBeVisible();
  // The first entry has the focus; ↓ walks down to General info…, Enter opens it.
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  const target = menu.getByRole('menuitem', { name: 'General info…', exact: true });
  for (let i = 0; i < 30 && !(await target.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('ArrowDown');
  await expect(target).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'General info' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  // Escape closes it, and the focus is back on the Map button.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(map).toBeFocused();
  // A submenu: → opens it, ← closes it, Escape closes the menu.
  await page.keyboard.press('Enter');
  const sub = menu.getByRole('menuitem', { name: 'Download & export', exact: true });
  for (let i = 0; i < 30 && !(await sub.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  // The submenu's first entry has the focus.
  const subMenu = page.getByRole('menu').nth(1);
  await expect(subMenu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(sub).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(map).toBeFocused();
});

test.afterAll(() => {
  if (!SURVEY) return;
  const before = existsSync(SURVEY) ? (JSON.parse(readFileSync(SURVEY, 'utf-8')) as typeof survey) : {};
  writeFileSync(SURVEY, JSON.stringify({ ...before, ...survey }, null, 2));
});
