// Dialogs and menus on a phone and a tablet: each one opens inside the
// screen (taller ones scroll inside themselves), nothing in it runs off the
// side, and its controls are 44 px tap targets. The home page's row menus,
// the new-thing dialogs, and the editor's dialogs (View on a phone; Edit on
// a tablet, through its Map menu; on a phone, through its Map sheet).
//
// SHOTS_DIR=<dir> saves a screenshot of each.

import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';
import { ensureUser, signIn, mapMenu } from '../helpers';
import { mapMenuDialogPaths } from '../../src/editor/mapMenuDialogs';
import { DEVICES, findOverflow, findSmallTargets } from '../mobileChecks';

const SHOTS = process.env.SHOTS_DIR;
const ts = Date.now();
const OWNER = `dialogs-owner-${ts}@example.com`;
let layoutId = '';

test.beforeAll(async ({ baseURL }) => {
  const cookies = await ensureUser(OWNER, 'Dialog Owner');
  const api = await playwrightRequest.newContext({ baseURL, storageState: { cookies, origins: [] } });
  try {
    // In a club, so Move or copy and "Save to" show up.
    expect((await api.post('/api/orgs', { data: { name: `Dialog Club ${ts}` } })).ok()).toBe(true);
    const res = await api.post('/api/layouts', { data: { title: 'Dialog Layout' } });
    layoutId = ((await res.json()) as { id: string }).id;
    await api.post('/api/venues', {
      data: { name: 'Dialog Hall', data: { name: 'Dialog Hall', enabled: true, minWalkwayStuds: 0, bounds: { x: 0, y: 0, w: 0, h: 0 }, edges: [], obstacles: [] } },
    });
    await api.post('/api/modules', { data: { title: 'Dialog Module' } });
  } finally {
    await api.dispose();
  }
});

/** The dialog or menu on top: fits the screen, nothing off the side, big enough to tap. */
async function checkOpen(page: Page, what: string, device: string) {
  // A dialog, a menu, or (older dialogs without a role) the box on a full-screen backdrop.
  const top = page.locator('[role=dialog]:visible, [role=menu]:visible, .fixed.inset-0.z-50 > :visible').last();
  await expect(top, `${what} opens`).toBeVisible();
  await page.waitForTimeout(250);
  const box = (await top.boundingBox())!;
  const vp = page.viewportSize()!;
  const id = `dialog-check-${Math.random().toString(36).slice(2)}`;
  await top.evaluate((el, id) => el.setAttribute('data-check', id), id);
  const scrolls = await top.evaluate((el) => {
    // It, or a box round it, scrolls when it's taller than the screen.
    for (let e: Element | null = el; e; e = e.parentElement) {
      const oy = getComputedStyle(e).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && e.clientHeight <= window.innerHeight + 1) return true;
    }
    return false;
  });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${device}--dialog-${what.replace(/\W+/g, '-').toLowerCase()}.png` });
  expect(box.x, `${what}: left edge on screen`).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width, `${what}: right edge on screen`).toBeLessThanOrEqual(vp.width + 1);
  if (box.height > vp.height + 1 || box.y < -1) expect(scrolls, `${what}: taller than the screen, so it scrolls`).toBe(true);
  expect(await findOverflow(page, `[data-check="${id}"]`), `${what}: nothing off the side`).toEqual([]);
  expect(await findSmallTargets(page, `[data-check="${id}"]`), `${what}: 44 px tap targets`).toEqual([]);
}

interface DialogCase {
  name: string;
  path: () => string;
  open: (page: Page) => Promise<void>;
  /** Only on a phone (View) or only on a tablet (Edit). */
  on?: 'phone' | 'tablet';
}

const more = (title: string, item?: string) => async (page: Page) => {
  await page.getByRole('button', { name: `More for ${title}` }).click();
  if (item) await page.getByRole('menuitem', { name: item }).click();
};
const mapItem = (path: string[]) => (page: Page) => mapMenu(page, ...path);
/** On a phone: Edit, then the layout-name menu ▸ Map… and down `path` in its sheet. */
const phoneMapItem = (path: string[]) => async (page: Page) => {
  await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).click();
  await page.getByRole('button', { name: /Dialog Layout/ }).first().click();
  await page.getByTestId('phone-map').click();
  for (const label of path) await page.getByRole('menu').last().getByRole('menuitem', { name: label, exact: true }).click();
};
const editor = () => `/editor/${layoutId}`;

const DIALOGS: DialogCase[] = [
  { name: 'layout row menu', path: () => '/', open: more('Dialog Layout') },
  { name: 'layout share', path: () => '/', open: more('Dialog Layout', 'Share…') },
  { name: 'layout move or copy', path: () => '/', open: more('Dialog Layout', 'Move or copy…') },
  { name: 'venue row menu', path: () => '/', open: more('Dialog Hall') },
  { name: 'module move or copy', path: () => '/', open: more('Dialog Module', 'Move or copy…') },
  { name: 'new layout', path: () => '/', open: (p) => p.getByRole('button', { name: 'New layout' }).click() },
  { name: 'new module', path: () => '/', open: (p) => p.getByRole('button', { name: 'New module' }).click() },
  { name: 'new venue', path: () => '/', open: (p) => p.getByRole('button', { name: 'New venue' }).click() },
  { name: 'editor share', path: editor, open: (p) => p.getByRole('button', { name: 'Share', exact: true }).click() },
  { name: 'editor share picture', path: editor, open: (p) => p.getByRole('button', { name: 'Share picture' }).first().click() },
  { name: 'editor help menu', path: editor, open: (p) => p.getByRole('button', { name: 'Help', exact: true }).click() },
  { name: 'editor layout menu', path: editor, on: 'phone', open: (p) => p.getByRole('button', { name: /Dialog Layout/ }).click() },
  { name: 'editor map menu', path: editor, on: 'tablet', open: (p) => p.getByRole('button', { name: 'Map', exact: true }).click() },
  { name: 'editor map menu venue page', path: editor, on: 'tablet', open: mapItem(['Venue']) },
  // Every dialog in the Map menu, read from the menu itself (mapMenuDialogs.ts).
  ...mapMenuDialogPaths().map((path): DialogCase => ({ name: `editor ${path.join(' › ').replace(/…/g, '')}`, path: editor, on: 'tablet', open: mapItem(path) })),
  // The phone's Map sheet reaches the same dialogs (Map menu entries with no other way in by touch).
  { name: 'editor phone map sheet', path: editor, on: 'phone', open: phoneMapItem([]) },
  ...[
    ['General info…'],
    ['Background color…'],
    ['Background image…'],
    ['Find…'],
    ['Insert', 'Text…'],
    ['Insert', 'Anchored label…'],
    ['Modules & sets', 'Save selection as set…'],
    ['Modules & sets', 'Import .bbm as module…'],
    ['Venue', 'Draw outline by dimensions…'],
    ['Venue', 'Edit venue properties…'],
    ['Budget', 'Edit budget…'],
    ['Download & export', 'Export part list…'],
    ['Preferences…'],
  ].map((path): DialogCase => ({ name: `phone ${path.at(-1)!.replace(/…/g, '')}`, path: editor, on: 'phone', open: phoneMapItem(path) })),
];

for (const device of DEVICES.filter((d) => ['360x740', '360x740-landscape', 'tablet-ipad-mini', 'tablet-ipad-mini-landscape'].includes(d.name))) {
  const kind = device.name.startsWith('tablet') ? 'tablet' : 'phone';
  test.describe(`dialogs on ${device.name}`, () => {
    test.use(device.use);
    for (const d of DIALOGS.filter((x) => !x.on || x.on === kind)) {
      test(`${d.name} fits and is easy to tap`, async ({ page }) => {
        await signIn(page, OWNER, 'Dialog Owner');
        await page.goto(d.path());
        if (d.path === editor) await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
        else await expect(page.getByText('Dialog Layout').first()).toBeVisible();
        await d.open(page);
        await checkOpen(page, d.name, device.name);
      });
    }
  });
}
