// Journey — public layouts and venues in the catalog.
//
//   1. The admin turns on the Layouts and Venues catalogs in Admin › Settings.
//   2. Olive shares a layout from the editor (Share › Share to the public
//      catalog) and a venue from its ⋯ menu on Home: both wait for review.
//   3. The moderator approves both.
//   4. A signed-out visitor opens the layout's page: the viewer, its size,
//      and the download links; and the venue's page.
//   5. Tom copies the layout to his layouts, and starts a layout in the
//      venue: the new layout has the venue's walls.

import { test, expect, type Page } from '@playwright/test';
import { ensureUser, signIn, adminSection } from '../../helpers';
import { makeGlobalAdmin, siteSettingsAtDefaults } from '../../dbHelpers';

siteSettingsAtDefaults();

test.setTimeout(240_000);
const ts = Date.now();
const ADMIN = `j-pub-admin-${ts}@example.com`;
const MOD = `j-pub-mod-${ts}@example.com`;
const OWNER = `j-pub-owner-${ts}@example.com`;
const TAKER = `j-pub-taker-${ts}@example.com`;
const LAYOUT = `Harbour ${ts}`;
const VENUE = `Town hall ${ts}`;

async function as(page: Page, email: string, name: string) {
  await page.context().clearCookies();
  await signIn(page, email, name);
}

const venueData = {
  name: VENUE,
  enabled: true,
  minWalkwayStuds: 30,
  bounds: { x: 0, y: 0, w: 600, h: 400 },
  edges: [
    { kind: 0, doorWidthStuds: 0, label: '', poly: [{ x: 0, y: 0 }, { x: 600, y: 0 }] },
    { kind: 0, doorWidthStuds: 0, label: '', poly: [{ x: 600, y: 0 }, { x: 600, y: 400 }] },
    { kind: 1, doorWidthStuds: 40, label: 'Door', poly: [{ x: 600, y: 400 }, { x: 0, y: 400 }] },
    { kind: 0, doorWidthStuds: 0, label: '', poly: [{ x: 0, y: 400 }, { x: 0, y: 0 }] },
  ],
  obstacles: [],
  notes: [{ x: 50, y: 50, text: 'Ask Bob for the key' }],
};

// Leave the catalogs as other specs expect them: off.
test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await as(page, ADMIN, 'Site Admin');
  await page.request.patch('/api/admin/settings', { data: { layoutCatalogEnabled: false, venueCatalogEnabled: false } });
  await page.close();
});

test('a layout and a venue are shared, reviewed, viewed signed out, copied, and a layout starts in the venue', async ({ page }) => {
  for (const [e, n] of [[ADMIN, 'Site Admin'], [MOD, 'Mo Derator'], [OWNER, 'Owner Olive'], [TAKER, 'Taker Tom']] as const) await ensureUser(e, n);
  makeGlobalAdmin(ADMIN);

  // 1. The admin turns both on, from Admin › Settings.
  await as(page, ADMIN, 'Site Admin');
  const modId = ((await (await page.request.get('/api/admin/users?q=' + encodeURIComponent(MOD))).json()) as { users: { id: string; email: string }[] }).users.find((u) => u.email === MOD)!.id;
  expect((await page.request.patch(`/api/admin/users/${modId}`, { data: { isModerator: true } })).ok()).toBe(true);
  expect((await page.request.patch('/api/admin/settings', { data: { catalogReview: 'moderators', catalogAnonymousBrowse: true, layoutCatalogEnabled: false, venueCatalogEnabled: false } })).ok()).toBe(true);
  await page.goto('/admin');
  await adminSection(page, 'settings');
  await page.getByLabel(/^Public layouts/).click();
  await expect(page.getByLabel(/^Public layouts/)).toBeChecked();
  await page.getByLabel(/^Public venues/).click();
  await expect(page.getByLabel(/^Public venues/)).toBeChecked();
  await expect.poll(async () => ((await (await page.request.get('/api/catalog/settings')).json()) as { venues: boolean }).venues).toBe(true);

  // 2. Olive shares a layout from the editor, and a venue from Home.
  await as(page, OWNER, 'Owner Olive');
  const layoutId = ((await (await page.request.post('/api/layouts', { data: { title: LAYOUT } })).json()) as { id: string }).id;
  expect((await page.request.post('/api/venues', { data: { name: VENUE, data: venueData } })).status()).toBe(201);
  await page.goto(`/editor/${layoutId}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByRole('button', { name: /Share to the public catalog/ }).click();
  const share = page.getByRole('dialog', { name: 'Share to the public catalog' });
  await expect(share).toContainText('Collaborators, comments, chat');
  await share.getByLabel('Description (optional)').fill('A small harbour');
  await share.getByRole('checkbox').check();
  await share.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(share.getByRole('status')).toContainText('Sent for review', { timeout: 20000 });
  await share.getByRole('button', { name: 'Done' }).click();

  await page.goto('/');
  const venueRow = page.locator('li', { hasText: VENUE });
  await venueRow.getByRole('button', { name: `More for ${VENUE}` }).click();
  await page.getByRole('menuitem', { name: 'Share to the public catalog…' }).click();
  const vshare = page.getByRole('dialog', { name: 'Share to the public catalog' });
  await expect(vshare).toContainText('Notes on the plan stay private');
  await vshare.getByRole('checkbox').check();
  await vshare.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(vshare.getByRole('status')).toContainText('Sent for review');
  await vshare.getByRole('button', { name: 'Done' }).click();
  await expect(venueRow.getByTestId('catalog-badge')).toHaveText('In review');

  // 3. The moderator approves both.
  await as(page, MOD, 'Mo Derator');
  await page.goto('/admin');
  await adminSection(page, 'moderation');
  for (const t of [LAYOUT, VENUE]) {
    const entry = page.getByTestId('moderation-entry').filter({ hasText: t });
    await entry.getByRole('button', { name: `Approve ${t}` }).click();
    await expect(entry).toHaveCount(0);
  }

  // 4. Signed out: the Layouts tab, the layout's page and the venue's page.
  await page.context().clearCookies();
  await page.goto('/catalog?kind=layout');
  await expect(page.getByRole('tab', { name: 'Layouts' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('link', { name: LAYOUT, exact: true }).click();
  await expect(page).toHaveURL(/\/catalog\/items\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Catalog layout · view only')).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();
  const panel = page.getByTestId('catalog-item-panel');
  await expect(panel).toContainText('by Owner Olive');
  await expect(panel).toContainText('A small harbour');
  await expect(panel.getByRole('link', { name: 'Sign in to copy it' })).toBeVisible();
  const bld = await page.request.get((await panel.getByRole('link', { name: 'Download .bld-layout' }).getAttribute('href'))!);
  expect(bld.headers()['content-disposition']).toContain('.bld-layout');
  const bbm = await page.request.get((await panel.getByRole('link', { name: /Download \.bbm/ }).getAttribute('href'))!);
  expect(bbm.ok()).toBe(true);
  await expect(panel.getByLabel('Share link')).toHaveValue(/\/catalog\/items\//);
  await page.goto('/catalog?kind=venue');
  await page.getByRole('link', { name: VENUE, exact: true }).click();
  await expect(page.getByText('Catalog venue · view only')).toBeVisible();
  await expect(page.getByTestId('catalog-item-panel')).toContainText('600 × 400 studs');

  // 5. Tom copies the layout, and starts a layout in the venue.
  await as(page, TAKER, 'Taker Tom');
  await page.goto('/catalog?kind=layout');
  await page.getByRole('button', { name: `Copy to my layouts: ${LAYOUT}` }).click();
  const add = page.getByRole('dialog', { name: `Add ${LAYOUT}` });
  await add.getByRole('button', { name: 'Add' }).click();
  await expect(add.getByRole('status')).toContainText('is now in your layouts');
  await add.getByRole('link', { name: 'Open it' }).click();
  await expect(page).toHaveURL(/\/editor\/[0-9a-f-]{36}$/);
  const mine = (await (await page.request.get('/api/layouts')).json()) as { layouts: { title: string }[] };
  expect(mine.layouts.some((l) => l.title === LAYOUT)).toBe(true);

  await page.goto('/catalog?kind=venue');
  await page.getByRole('link', { name: VENUE, exact: true }).click();
  await page.getByTestId('catalog-item-panel').getByRole('button', { name: 'Start a layout in this venue' }).click();
  const create = page.getByRole('dialog', { name: 'New layout' });
  await expect(create.getByRole('combobox')).toHaveValue(/.+/);
  await create.getByLabel('Title').fill(`In the hall ${ts}`);
  await create.getByRole('button', { name: 'Create' }).click();
  await expect(page).toHaveURL(/\/editor\/[0-9a-f-]{36}$/);
  const id = /\/editor\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
  await expect
    .poll(async () => {
      const r = await page.request.get(`/api/layouts/${id}/export.bbm.bld`);
      if (!r.ok()) return 'none';
      const v = ((await r.json()) as { venue?: { edges: unknown[]; notes?: unknown[] } }).venue;
      return `${v?.edges.length ?? 0} edges, notes ${v?.notes ? 'kept' : 'left out'}`;
    }, { timeout: 15000 })
    .toBe('4 edges, notes left out');
});
