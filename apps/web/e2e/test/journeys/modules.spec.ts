// Journey 3 — a module, from first click to someone else's layout.
//
// This is the "New module made a blank module nothing could open" check:
// every step uses what the step before it made, the way a club member
// would, and each result is looked at again after a reload.
//
//   New module → build it in the editor → its picture on Home → save again
//   (a second version) → restore the first version → insert it into a
//   layout (still there after a reload) → share it to the public catalog →
//   a moderator approves it → another member adds it and uses it in their
//   own layout → the owner publishes an update → the copy offers it.

import { test, expect, type Page } from '@playwright/test';
import { ensureUser, signIn, fromSettingsMenu, confirmInDialog, adminSection } from '../../helpers';
import { makeGlobalAdmin, siteSettingsAtDefaults } from '../../dbHelpers';

siteSettingsAtDefaults();

test.describe.configure({ mode: 'serial' });

const ts = Date.now();
const OWNER = `j-mod-owner-${ts}@example.com`;
const MOD = `j-mod-moderator-${ts}@example.com`;
const TAKER = `j-mod-taker-${ts}@example.com`;
const ADMIN = `j-mod-admin-${ts}@example.com`;
const TITLE = `Goods yard ${ts}`;
const PART = 'ts_narrowgauge_straight.8';

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

async function placePart(page: Page): Promise<void> {
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
}

async function as(page: Page, email: string, name: string): Promise<void> {
  await page.context().clearCookies();
  await signIn(page, email, name);
}

const moduleRow = (page: Page) => page.getByTestId('module-row').filter({ hasText: TITLE });

/** A picture that really loaded (not a broken image). */
async function expectLoadedPicture(img: ReturnType<Page['locator']>): Promise<void> {
  await expect(img).toBeVisible({ timeout: 15000 });
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10000 }).toBeGreaterThan(0);
}

/** Home → New layout → Create; the editor is open. */
async function newLayoutFromHome(page: Page, title: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New layout', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New layout' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/editor\/[0-9a-f-]{36}$/);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
}

/** Insert module → pick TITLE → Insert; `parts` bricks on the map. */
async function insertTheModule(page: Page, parts: number): Promise<void> {
  await page.getByRole('button', { name: 'Insert module' }).click();
  const row = page.locator('li', { hasText: TITLE }).filter({ has: page.getByRole('button', { name: 'Insert' }) });
  await expectLoadedPicture(row.getByTestId('module-thumb'));
  await row.getByRole('button', { name: 'Insert' }).click();
  await expect.poll(() => brickCount(page)).toBe(parts);
}

test.beforeAll(async () => {
  for (const [e, n] of [[OWNER, 'Owner Ola'], [MOD, 'Mod Mia'], [TAKER, 'Taker Tia'], [ADMIN, 'Admin Ari']] as const) await ensureUser(e, n);
  makeGlobalAdmin(ADMIN);
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await as(page, ADMIN, 'Admin Ari');
  await page.request.patch('/api/admin/settings', { data: { moduleCatalogEnabled: false } });
  await page.close();
});

test('a module goes from New module to another member’s layout', async ({ page }) => {
  test.setTimeout(240_000);

  // ── New module → editor: build it and save. ──
  await as(page, OWNER, 'Owner Ola');
  await page.goto('/');
  await page.getByRole('button', { name: 'New module' }).click();
  const create = page.getByRole('dialog', { name: 'New module' });
  await create.getByLabel('Title').fill(TITLE);
  await create.getByRole('button', { name: 'Create and open' }).click();
  await expect(page).toHaveURL(/\/modules\/[0-9a-f-]{36}$/);
  const moduleId = /\/modules\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  await expect(page.getByTestId('module-editor-title')).toHaveText(`Editing module: ${TITLE}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await placePart(page);
  await expect.poll(() => brickCount(page)).toBe(1);
  await page.getByLabel('What changed (optional)').fill('One track');
  await page.getByRole('button', { name: 'Save module' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved');

  // ── Its picture on Home; open it again from there. ──
  await page.getByRole('button', { name: 'Home' }).click();
  await expectLoadedPicture(moduleRow(page).getByTestId('module-thumb'));
  await moduleRow(page).getByRole('link', { name: `Open ${TITLE}` }).click();
  await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(1);

  // ── Save over it: a second version with two tracks. ──
  await placePart(page);
  await expect.poll(() => brickCount(page)).toBe(2);
  await page.getByLabel('What changed (optional)').fill('Second track');
  await page.getByRole('button', { name: 'Save module' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
  await page.reload();
  await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(2);

  // ── Restore version 1 from the history: it becomes version 3. ──
  await page.goto('/');
  await moduleRow(page).getByRole('button', { name: `More for ${TITLE}` }).click();
  await page.getByRole('menuitem', { name: 'Version history…' }).click();
  const history = page.getByRole('dialog', { name: `Versions of ${TITLE}` });
  await expect(history.getByTestId('module-version')).toHaveCount(2);
  await history.getByRole('button', { name: 'Restore version 1' }).click();
  await confirmInDialog(page);
  await expect(history.getByRole('status')).toContainText('saved as version 3');
  await history.getByRole('button', { name: 'Close' }).click();
  await expect(moduleRow(page)).toContainText('version 3');
  await page.goto(`/modules/${moduleId}`);
  await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(1);

  // ── Insert it into a new layout; it is still there after a reload. ──
  await newLayoutFromHome(page, `Show layout ${ts}`);
  await insertTheModule(page, 1);
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 15000 });
  await page.reload();
  await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(1);

  // ── The site's admin opens the module catalog and names a moderator. ──
  await as(page, ADMIN, 'Admin Ari');
  await page.goto('/admin');
  await adminSection(page, 'settings');
  const catalogToggle = page.getByLabel('Public module catalog');
  if (!(await catalogToggle.isChecked())) await catalogToggle.click();
  await expect(catalogToggle).toBeChecked();
  await adminSection(page, 'users');
  await page.getByLabel(`Moderator: ${MOD}`).click();
  await expect(page.getByLabel(`Moderator: ${MOD}`)).toBeChecked();

  // ── The owner shares it. ──
  await as(page, OWNER, 'Owner Ola');
  await page.goto('/');
  await moduleRow(page).getByRole('button', { name: `More for ${TITLE}` }).click();
  await page.getByRole('menuitem', { name: 'Share to the public catalog…' }).click();
  const share = page.getByRole('dialog', { name: 'Share to the public catalog' });
  await share.getByLabel('Description (optional)').fill('A goods yard for a narrow gauge line.');
  await share.getByLabel('Anyone can copy this into their own layouts.').check();
  await share.getByRole('button', { name: 'Share' }).click();
  await expect(share.getByRole('status')).toContainText('Sent for review');
  await share.getByRole('button', { name: 'Done' }).click();
  await expect(moduleRow(page).getByTestId('catalog-badge')).toHaveText('In review');

  // ── The moderator approves it. ──
  await as(page, MOD, 'Mod Mia');
  await page.goto('/');
  await fromSettingsMenu(page, /^Moderation/);
  const entry = page.getByTestId('moderation-entry').filter({ hasText: TITLE });
  await entry.getByRole('button', { name: `Approve ${TITLE}` }).click();
  await expect(entry).toHaveCount(0);

  // ── Another member adds it and uses it in their own layout. ──
  await as(page, TAKER, 'Taker Tia');
  await page.goto('/');
  await page.getByRole('link', { name: 'Catalog' }).click();
  await page.getByLabel('Search the catalog').fill(TITLE);
  const card = page.getByTestId('catalog-item').filter({ hasText: TITLE });
  await expect(card).toContainText('by Owner Ola');
  await expectLoadedPicture(card.getByTestId('catalog-preview'));
  await card.getByRole('button', { name: `Add to my modules: ${TITLE}` }).click();
  const add = page.getByRole('dialog', { name: `Add ${TITLE}` });
  await add.getByRole('button', { name: 'Add' }).click();
  await expect(add.getByRole('status')).toContainText('now in your modules');
  await newLayoutFromHome(page, `Taker layout ${ts}`);
  await insertTheModule(page, 1);

  // ── The owner publishes an update; the moderator approves it. ──
  await as(page, OWNER, 'Owner Ola');
  await page.goto(`/modules/${moduleId}`);
  await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(1);
  await placePart(page);
  await placePart(page);
  await expect.poll(() => brickCount(page)).toBe(3);
  await page.getByRole('button', { name: 'Save module' }).click();
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
  await page.getByRole('button', { name: 'Publish update…' }).click();
  const upd = page.getByRole('dialog', { name: 'Share to the public catalog' });
  await upd.getByLabel('Anyone can copy this into their own layouts.').check();
  await upd.getByRole('button', { name: 'Publish update' }).click();
  await expect(upd.getByRole('status')).toContainText('Sent for review');
  await as(page, MOD, 'Mod Mia');
  await page.goto('/');
  await fromSettingsMenu(page, /^Moderation/);
  await page.getByTestId('moderation-entry').filter({ hasText: TITLE }).getByRole('button', { name: `Approve ${TITLE}` }).click();
  await expect(page.getByTestId('moderation-entry').filter({ hasText: TITLE })).toHaveCount(0);

  // ── The copy offers the update; taking it brings the new tracks. ──
  await as(page, TAKER, 'Taker Tia');
  await page.goto('/');
  await expect(moduleRow(page)).toContainText('Update available');
  await moduleRow(page).getByRole('button', { name: `Get the new version of ${TITLE}` }).click();
  await expect(moduleRow(page)).not.toContainText('Update available');
  await moduleRow(page).getByRole('link', { name: `Open ${TITLE}` }).click();
  await expect.poll(() => brickCount(page), { timeout: 15000 }).toBe(3);
});
