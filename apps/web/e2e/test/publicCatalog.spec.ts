// Public catalogs, end to end: an admin turns them on and makes a
// moderator; an owner shares a module; the moderator approves it; someone
// else finds it in the Catalog, adds it and opens their copy; an update is
// shared, approved and fetched with "Get the new version"; an admin
// unpublishes it (the copy keeps working). Parts: shared straight away and
// added from the editor's Parts panel. With the catalogs off nothing shows.

import { test, expect, type Page } from '@playwright/test';
import { ensureUser, signIn, fromSettingsMenu, confirmInDialog, adminSection } from '../helpers';
import { makeGlobalAdmin, siteSettingsAtDefaults } from '../dbHelpers';

siteSettingsAtDefaults();

test.describe.configure({ mode: 'serial' });

const ts = Date.now();
const ADMIN = `cat-admin-${ts}@example.com`;
const MOD = `cat-mod-${ts}@example.com`;
const OWNER = `cat-owner-${ts}@example.com`;
const TAKER = `cat-taker-${ts}@example.com`;
const PART = 'ts_narrowgauge_straight.8';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const XML = Buffer.from('<?xml version="1.0"?><part><Author>e2e</Author></part>').toString('base64');

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}
async function placePart(page: Page) {
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
}
async function as(page: Page, email: string, name: string) {
  await page.context().clearCookies();
  await signIn(page, email, name);
}
async function setSettings(page: Page, patch: Record<string, unknown>) {
  await as(page, ADMIN, 'Site Admin');
  expect((await page.request.patch('/api/admin/settings', { data: patch })).ok()).toBe(true);
}
const moduleRow = (page: Page, title: string) => page.getByTestId('module-row').filter({ hasText: title });

test.beforeAll(async () => {
  for (const [e, n] of [[ADMIN, 'Site Admin'], [MOD, 'Mo Derator'], [OWNER, 'Owner Olive'], [TAKER, 'Taker Tom']] as const) await ensureUser(e, n);
  makeGlobalAdmin(ADMIN);
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await setSettings(page, { moduleCatalogEnabled: false, partsCatalogEnabled: false, catalogReview: 'moderators', catalogAnonymousBrowse: true });
  await page.close();
});

test('off by default: no Catalog link, no Share item, and /catalog says it is closed', async ({ page }) => {
  await setSettings(page, { moduleCatalogEnabled: false, partsCatalogEnabled: false, layoutCatalogEnabled: false, venueCatalogEnabled: false });
  await as(page, OWNER, 'Owner Olive');
  await page.request.post('/api/modules', { data: { title: 'Closed shed' } });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Catalog' })).toHaveCount(0);
  await moduleRow(page, 'Closed shed').getByRole('button', { name: 'More for Closed shed' }).click();
  await expect(page.getByRole('menuitem', { name: /public catalog/ })).toHaveCount(0);
  await page.goto('/catalog');
  await expect(page.getByText('The public catalog isn’t open on this site.')).toBeVisible();
  // A site admin is told where to open it.
  await as(page, ADMIN, 'Site Admin');
  await page.goto('/catalog');
  await expect(page.getByRole('link', { name: 'Admin › Settings' })).toHaveAttribute('href', '/admin');
});

test('share, review, find, add, update and unpublish a module', async ({ page }) => {
  // The admin turns the module catalog on and makes a moderator, in Admin.
  await as(page, ADMIN, 'Site Admin');
  await page.goto('/admin');
  await adminSection(page, 'settings');
  await page.getByLabel('Public module catalog').click();
  await expect(page.getByLabel('Public module catalog')).toBeChecked();
  await expect(page.getByLabel('Moderators approve each one')).toBeChecked();
  await adminSection(page, 'users');
  await page.getByLabel(`Moderator: ${MOD}`).click();
  await expect(page.getByLabel(`Moderator: ${MOD}`)).toBeChecked();

  // The owner builds a module and shares it.
  await as(page, OWNER, 'Owner Olive');
  await page.goto('/');
  await page.getByRole('button', { name: 'New module' }).click();
  await page.getByRole('dialog', { name: 'New module' }).getByLabel('Title').fill('Coal stage');
  await page.getByRole('button', { name: 'Create and open' }).click();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await placePart(page);
  await expect.poll(() => brickCount(page)).toBe(1);
  await page.getByRole('button', { name: 'Save module' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
  await page.goto('/');
  await moduleRow(page, 'Coal stage').getByRole('button', { name: 'More for Coal stage' }).click();
  await page.getByRole('menuitem', { name: 'Share to the public catalog…' }).click();
  const share = page.getByRole('dialog', { name: 'Share to the public catalog' });
  await share.getByLabel('Description (optional)').fill('A small coal stage for a branch line.');
  await share.getByLabel(/Tags/).fill('coal, branch line');
  await share.getByRole('button', { name: 'Share' }).click();
  await expect(share.getByText('Tick the box')).toBeVisible();
  await share.getByLabel('Anyone can copy this into their own layouts.').check();
  await share.getByRole('button', { name: 'Share' }).click();
  await expect(share.getByRole('status')).toContainText('Sent for review');
  await share.getByRole('button', { name: 'Done' }).click();
  await expect(moduleRow(page, 'Coal stage').getByTestId('catalog-badge')).toHaveText('In review');

  // Not in the catalog yet.
  await as(page, TAKER, 'Taker Tom');
  // (Other specs may have left modules of their own in the catalog.)
  await page.goto('/catalog?kind=module&q=coal+stage');
  await expect(page.getByText('Nothing matches.')).toBeVisible();

  // The moderator sees who sent it, by their public name (only site
  // admins see the address), and approves it.
  await as(page, MOD, 'Mo Derator');
  await page.goto('/');
  await fromSettingsMenu(page, /^Moderation/);
  const entry = page.getByTestId('moderation-entry').filter({ hasText: 'Coal stage' });
  await expect(entry).toContainText('From Owner Olive, sent by Owner Olive');
  await expect(entry).not.toContainText(OWNER);
  await expect(page.getByRole('navigation', { name: 'Admin sections' })).toHaveCount(0);
  await entry.getByRole('button', { name: 'Approve Coal stage' }).click();
  await expect(entry).toHaveCount(0);

  // Someone else finds it, adds it and opens their copy.
  await as(page, TAKER, 'Taker Tom');
  await page.goto('/');
  await page.getByRole('link', { name: 'Catalog' }).click();
  await page.getByLabel('Search the catalog').fill('coal');
  const card = page.getByTestId('catalog-item').filter({ hasText: 'Coal stage' });
  await expect(card).toContainText('by Owner Olive');
  await expect.poll(() => card.getByTestId('catalog-preview').evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await card.getByRole('button', { name: 'Add to my modules: Coal stage' }).click();
  const add = page.getByRole('dialog', { name: 'Add Coal stage' });
  await add.getByRole('button', { name: 'Add' }).click();
  await expect(add.getByRole('status')).toContainText('now in your modules');
  await add.getByRole('link', { name: 'Open it' }).click();
  await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(1);
  await page.goto('/catalog');
  await expect(page.getByTestId('catalog-item').filter({ hasText: 'Coal stage' })).toContainText('1 use');

  // The owner changes it and publishes the update; an admin approves it.
  await as(page, OWNER, 'Owner Olive');
  await page.goto('/');
  await moduleRow(page, 'Coal stage').getByRole('link', { name: 'Open Coal stage' }).click();
  await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(1);
  await placePart(page);
  await expect.poll(() => brickCount(page)).toBe(2);
  await page.getByRole('button', { name: 'Save module' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Publish update…' }).click();
  const upd = page.getByRole('dialog', { name: 'Share to the public catalog' });
  await upd.getByLabel('What changed? (optional)').fill('Second siding');
  await upd.getByLabel('Anyone can copy this into their own layouts.').check();
  await upd.getByRole('button', { name: 'Publish update' }).click();
  await expect(upd.getByRole('status')).toContainText('Sent for review');
  await as(page, ADMIN, 'Site Admin');
  await page.goto('/admin');
  await adminSection(page, 'moderation');
  const upEntry = page.getByTestId('moderation-entry').filter({ hasText: 'Coal stage' });
  await expect(upEntry).toContainText('update, version 2');
  await upEntry.getByRole('button', { name: 'Approve Coal stage' }).click();
  await expect(upEntry).toHaveCount(0);

  // The copy shows "Update available"; getting it brings the second part.
  await as(page, TAKER, 'Taker Tom');
  await page.goto('/');
  const copyRow = moduleRow(page, 'Coal stage');
  await expect(copyRow).toContainText('Update available');
  await copyRow.getByRole('button', { name: 'Get the new version of Coal stage' }).click();
  await expect(copyRow).not.toContainText('Update available');
  await copyRow.getByRole('link', { name: 'Open Coal stage' }).click();
  await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(2);

  // An admin unpublishes it: gone from the catalog, the copy still opens.
  await as(page, ADMIN, 'Site Admin');
  await page.goto('/admin');
  await adminSection(page, 'moderation');
  await page.getByRole('tab', { name: /^In the catalog/ }).click();
  await page.getByRole('button', { name: 'Unpublish Coal stage' }).click();
  await confirmInDialog(page, { reason: 'No longer allowed' });
  await page.getByRole('radiogroup', { name: 'Show' }).getByText(/^Unpublished/).click();
  await expect(page.getByText(/Unpublished: No longer allowed/)).toBeVisible();
  await as(page, TAKER, 'Taker Tom');
  // (Other specs may have left modules of their own in the catalog.)
  await page.goto('/catalog?kind=module&q=coal+stage');
  await expect(page.getByText('Nothing matches.')).toBeVisible();
  await page.goto('/');
  await moduleRow(page, 'Coal stage').getByRole('link', { name: 'Open Coal stage' }).click();
  await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(2);
});

test('parts: shared straight away, added from the Parts panel; modules inserted from the catalog tab', async ({ page }) => {
  await setSettings(page, { moduleCatalogEnabled: true, partsCatalogEnabled: true, catalogReview: 'none' });
  await as(page, OWNER, 'Owner Olive');
  const res = await page.request.post('/api/custom-parts', {
    data: { partNumber: `SIG${ts}`, displayName: `Home signal ${ts}`, xmlBase64: XML, spriteBase64: PNG, spriteMime: 'image/png' },
  });
  expect(res.ok()).toBe(true);
  await page.goto('/#parts');
  const partRow = page.locator('#parts li').filter({ hasText: `Home signal ${ts}` });
  await partRow.getByRole('button', { name: `More for SIG${ts}` }).click();
  await page.getByRole('menuitem', { name: 'Share to the public catalog…' }).click();
  const share = page.getByRole('dialog', { name: 'Share to the public catalog' });
  await share.getByLabel('Anyone can copy this into their own layouts.').check();
  await share.getByRole('button', { name: 'Share' }).click();
  await expect(share.getByRole('status')).toContainText('in the public catalog now');
  await share.getByRole('button', { name: 'Done' }).click();
  await expect(partRow.getByTestId('catalog-badge')).toHaveText('Public');
  // A module, shared straight away too.
  await page.request.post('/api/modules', { data: { title: 'Water tower' } });

  // The taker adds the part from the editor's Parts panel, and inserts a module from the Catalog tab.
  await as(page, TAKER, 'Taker Tom');
  const lay = await page.request.post('/api/layouts', { data: { title: 'Taker layout' } });
  const { id: layoutId } = (await lay.json()) as { id: string };
  await page.goto(`/editor/${layoutId}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'From the catalog…' }).click();
  const parts = page.getByRole('dialog', { name: 'Parts from the catalog' });
  await parts.getByRole('button', { name: `Add Home signal ${ts}` }).click();
  await expect(parts.getByText('Added')).toBeVisible();
  await parts.getByRole('button', { name: 'Close' }).click();
  await page.getByPlaceholder('Search parts (name or number)').first().fill(`Home signal ${ts}`);
  await expect(page.locator(`[title*="Home signal ${ts}"]`).first()).toBeVisible({ timeout: 15000 });
  // The Coal stage is unpublished; insert a module that is public. Shared
  // again, a moderator's takedown goes back through review (even with
  // review off), and a moderator approves it.
  await as(page, OWNER, 'Owner Olive');
  await page.goto('/');
  await moduleRow(page, 'Coal stage').getByRole('button', { name: 'More for Coal stage' }).click();
  await page.getByRole('menuitem', { name: 'Publish this update…' }).click();
  const again = page.getByRole('dialog', { name: 'Share to the public catalog' });
  await again.getByLabel('Anyone can copy this into their own layouts.').check();
  await again.getByRole('button', { name: 'Publish update' }).click();
  await expect(again.getByRole('status')).toContainText('Sent for review');
  await as(page, ADMIN, 'Site Admin');
  await page.goto('/admin');
  await adminSection(page, 'moderation');
  const back = page.getByTestId('moderation-entry').filter({ hasText: 'Coal stage' });
  await back.getByRole('button', { name: 'Approve Coal stage' }).click();
  await expect(back).toHaveCount(0);
  await as(page, TAKER, 'Taker Tom');
  await page.goto(`/editor/${layoutId}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Insert module' }).click();
  await page.getByRole('tab', { name: 'Catalog' }).click();
  await page.getByRole('button', { name: 'Add and insert Coal stage' }).click();
  await expect.poll(() => brickCount(page)).toBe(2);
});
