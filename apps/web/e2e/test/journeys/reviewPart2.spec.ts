// Journey: the smaller fixes from the area 3 review, part 2.
//
//   Ada invites Bob to her club; Bob's Home shows the invite (without a
//   reload) and Join takes him into the club. In the editor the Panels menu
//   says it's open and Esc closes it; a sheet's right-click menu is a menu
//   with items and Esc; the Budget window opens clear of the Parts panel and
//   names the parts. On a tablet the Edit toolbar leaves Cut, Copy and the
//   rest to the touch bar; on a phone the touch bar says how many are
//   picked. At 768 px the site header stays on one row.
//
// SHOTS=<dir> saves light and dark pictures of each step.

import { test, expect, devices, request as playwrightRequest, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureUser, signIn, mapMenu } from '../../helpers';

const ts = Date.now();
const ADA = `j-p2-ada-${ts}@example.com`;
const BOB = `j-p2-bob-${ts}@example.com`;
const PART = 'ts_narrowgauge_straight.8';
const SHOTS = process.env.SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
  }
}

async function newLayout(page: Page, title: string): Promise<string> {
  const res = await page.request.post('/api/layouts', { data: { title } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  return id;
}

test('a club invite shows on Home, live, and Join takes you into the club', async ({ page, baseURL }) => {
  await signIn(page, BOB, 'Bob Builder');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Layouts' })).toBeVisible();
  await expect(page.getByTestId('my-invites')).toHaveCount(0);

  const ada = await playwrightRequest.newContext({ baseURL, storageState: { cookies: await ensureUser(ADA, 'Ada Admin'), origins: [] } });
  try {
    expect((await ada.post('/api/orgs', { data: { name: `Ada Club ${ts}`, slug: `ada-club-${ts}` } })).ok()).toBe(true);
    expect((await ada.post(`/api/orgs/ada-club-${ts}/invites`, { data: { email: BOB, role: 'member' } })).ok()).toBe(true);
  } finally {
    await ada.dispose();
  }
  // No reload: the invite's hint brings it in.
  const card = page.getByTestId('my-invites');
  await expect(card).toContainText(`Ada Club ${ts}`, { timeout: 15000 });
  await shot(page, 'home-invite');
  await card.getByRole('button', { name: `Join Ada Club ${ts}` }).click();
  await expect(page).toHaveURL(new RegExp(`/orgs/ada-club-${ts}$`));
});

test.describe('editor menus and windows', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('Panels and a sheet’s menu are menus a keyboard can leave; the Budget window clears the Parts panel', async ({ page }) => {
    await signIn(page, ADA, 'Ada Admin');
    await newLayout(page, `Menus ${ts}`);
    const panels = page.getByRole('button', { name: 'Panels', exact: true });
    await expect(panels).toHaveAttribute('aria-haspopup', 'true');
    await panels.click();
    await expect(panels).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByLabel('Venue library')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('Venue library')).toHaveCount(0);
    await expect(panels).toHaveAttribute('aria-expanded', 'false');
    await expect(panels).toBeFocused();

    // A sheet's right-click menu.
    await page.getByText('Grid', { exact: true }).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: /Sheet Grid/ });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await shot(page, 'sheet-menu');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // The Budget window, with a part to count: clear of the Parts panel, with names.
    await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
    await page.locator(`[title*="(${PART})"]`).first().click();
    await mapMenu(page, 'Budget', 'Edit budget…');
    const budget = page.getByRole('dialog', { name: 'Budget' });
    await expect(budget).toContainText('Narrow Gauge');
    await expect(budget.getByRole('button', { name: 'Close the budget' })).toBeVisible();
    const parts = (await page.getByPlaceholder('Search parts (name or number)').first().boundingBox())!;
    const box = (await budget.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(parts.x);
    await shot(page, 'budget-window');
  });
});

test.describe('on a tablet', () => {
  const { defaultBrowserType: _b, ...iPad } = devices['iPad (gen 7)'];
  test.use(iPad);

  test('the Edit toolbar leaves the picked-part buttons to the touch bar', async ({ page }) => {
    await signIn(page, ADA, 'Ada Admin');
    await newLayout(page, `Tablet ${ts}`);
    const toolbar = page.getByRole('toolbar', { name: 'Edit', exact: true });
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Save' })).toBeVisible();
    for (const name of ['Cut', 'Copy', 'Paste', 'Send to back']) await expect(toolbar.getByRole('button', { name, exact: true })).toHaveCount(0);
    await expect(page.getByTestId('touch-bar').getByRole('button', { name: 'Paste' })).toBeVisible();
    await shot(page, 'tablet-toolbar');
  });
});

test.describe('on a phone', () => {
  const { defaultBrowserType: _p, ...pixel7 } = devices['Pixel 7'];
  test.use(pixel7);

  test('the touch bar says how many are picked', async ({ page }) => {
    await signIn(page, ADA, 'Ada Admin');
    await newLayout(page, `Phone ${ts}`);
    await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
    await page.getByTestId('add-part').tap();
    const sheet = page.getByRole('dialog', { name: 'Add a part' });
    await sheet.getByRole('searchbox', { name: 'Search parts' }).fill('narrow gauge track straight 4 x 16');
    await sheet.locator(`[data-part-key="${PART}"]`).tap();
    await expect(page.getByTestId('picked-count')).toHaveText('1 picked');
    await shot(page, 'phone-picked');
  });
});

test.describe('at 768 px', () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test('the site header stays on one row', async ({ page }) => {
    await signIn(page, ADA, 'Ada Admin');
    await page.goto('/');
    const header = page.locator('header').first();
    await expect(header).toBeVisible();
    const menu = (await page.getByRole('button', { name: /Menu/ }).first().boundingBox())!;
    const home = (await page.getByRole('navigation', { name: 'Site' }).getByRole('link', { name: 'Home' }).boundingBox())!;
    // Same row: the Menu button's middle is level with the page links.
    expect(Math.abs(menu.y + menu.height / 2 - (home.y + home.height / 2))).toBeLessThan(12);
    await shot(page, 'header-768');
  });
});
