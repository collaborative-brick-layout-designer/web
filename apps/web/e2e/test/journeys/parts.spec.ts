// Journey 4 — a custom part, from upload to another member's desktop.
//
// In the real setup: the parts catalog on, moderators approve each share.
//
//   Upload a custom part on Home → it is in the editor's Parts panel →
//   place it → share it to the catalog ("In review") → a moderator approves
//   it → another member adds it from the Parts panel and places it → the
//   desktop's parts sync (the manifest) lists it for them.

import { test, expect, type Page } from '@playwright/test';
import { ensureUser, signIn, fromSettingsMenu, adminSection } from '../../helpers';
import { makeGlobalAdmin, siteSettingsAtDefaults } from '../../dbHelpers';

siteSettingsAtDefaults();

test.describe.configure({ mode: 'serial' });

const ts = Date.now();
const OWNER = `j-part-owner-${ts}@example.com`;
const MOD = `j-part-mod-${ts}@example.com`;
const TAKER = `j-part-taker-${ts}@example.com`;
const ADMIN = `j-part-admin-${ts}@example.com`;
const NUMBER = `JSIG${ts}`;
const NAME = `Signal box ${ts}`;
// A minimal part file and a 1 × 1 sprite, as the other parts specs use.
const XML = `<?xml version="1.0"?><part><Author>journey</Author></part>`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

async function as(page: Page, email: string, name: string): Promise<void> {
  await page.context().clearCookies();
  await signIn(page, email, name);
}

async function placeOurPart(page: Page): Promise<void> {
  await page.getByPlaceholder('Search parts (name or number)').first().fill(NAME);
  const tile = page.locator(`[title*="${NAME}"]`).first();
  await expect(tile).toBeVisible({ timeout: 15000 });
  await tile.dblclick();
}

async function newLayout(page: Page, title: string): Promise<void> {
  const res = await page.request.post('/api/layouts', { data: { title } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
}

test.beforeAll(async ({ browser }) => {
  for (const [e, n] of [[OWNER, 'Owner Oli'], [MOD, 'Mod Max'], [TAKER, 'Taker Tess'], [ADMIN, 'Admin Abe']] as const) await ensureUser(e, n);
  makeGlobalAdmin(ADMIN);
  // The real setup: the parts catalog on, reviewed by moderators.
  const page = await browser.newPage();
  await signIn(page, ADMIN, 'Admin Abe');
  expect((await page.request.patch('/api/admin/settings', { data: { partsCatalogEnabled: true, catalogReview: 'moderators' } })).ok()).toBe(true);
  await page.close();
});

test('a custom part goes from upload to another member’s layout and desktop', async ({ page }) => {
  test.setTimeout(240_000);

  // ── The admin names a moderator. ──
  await as(page, ADMIN, 'Admin Abe');
  await page.goto('/admin');
  await adminSection(page, 'users');
  await page.getByLabel(`Moderator: ${MOD}`).click();
  await expect(page.getByLabel(`Moderator: ${MOD}`)).toBeChecked();

  // ── Upload a custom part on Home. ──
  await as(page, OWNER, 'Owner Oli');
  await page.goto('/?owner=me');
  const parts = page.locator('#parts');
  await parts.getByRole('button', { name: 'Upload part' }).click();
  const upload = page.getByRole('dialog', { name: 'Upload custom part' });
  await upload.getByLabel('Part number').fill(NUMBER);
  await upload.getByLabel('Display name').fill(NAME);
  await upload.getByLabel('Part XML').setInputFiles({ name: 'signal.xml', mimeType: 'text/xml', buffer: Buffer.from(XML) });
  await upload.getByLabel('Sprite (gif or png)').setInputFiles({ name: 'signal.png', mimeType: 'image/png', buffer: PNG });
  await upload.getByRole('button', { name: 'Upload' }).click();
  await expect(upload).toHaveCount(0);
  const partRow = parts.getByRole('listitem').filter({ hasText: NAME });
  await expect(partRow.getByTestId('owner-chip')).toHaveText('Me');

  // ── It is in the editor's Parts panel; place it. ──
  await newLayout(page, `Owner layout ${ts}`);
  await placeOurPart(page);
  await expect.poll(() => brickCount(page)).toBe(1);

  // ── Share it: it waits for review. ──
  await page.goto('/#parts');
  await partRow.getByRole('button', { name: `More for ${NUMBER}` }).click();
  await page.getByRole('menuitem', { name: 'Share to the public catalog…' }).click();
  const share = page.getByRole('dialog', { name: 'Share to the public catalog' });
  await share.getByLabel('Anyone can copy this into their own layouts.').check();
  await share.getByRole('button', { name: 'Share' }).click();
  await expect(share.getByRole('status')).toContainText('Sent for review');
  await share.getByRole('button', { name: 'Done' }).click();
  await expect(partRow.getByTestId('catalog-badge')).toHaveText('In review');

  // ── The moderator approves it. ──
  await as(page, MOD, 'Mod Max');
  await page.goto('/');
  await fromSettingsMenu(page, /^Moderation/);
  const entry = page.getByTestId('moderation-entry').filter({ hasText: NAME });
  await entry.getByRole('button', { name: new RegExp(`^Approve`) }).click();
  await expect(entry).toHaveCount(0);

  // ── Another member adds it from the Parts panel and places it. ──
  await as(page, TAKER, 'Taker Tess');
  await newLayout(page, `Taker layout ${ts}`);
  await page.getByRole('button', { name: 'From the catalog…' }).click();
  const fromCatalog = page.getByRole('dialog', { name: 'Parts from the catalog' });
  await fromCatalog.getByRole('button', { name: `Add ${NAME}` }).click();
  await expect(fromCatalog.getByText('Added')).toBeVisible();
  await fromCatalog.getByRole('button', { name: 'Close' }).click();
  await placeOurPart(page);
  await expect.poll(() => brickCount(page)).toBe(1);

  // ── The desktop's parts sync lists it for them, with its files. ──
  const manifest = (await (await page.request.get('/api/parts/manifest')).json()) as {
    customParts: { partNumber: string; displayName: string; xmlUrl: string; spriteUrl: string }[];
  };
  const mine = manifest.customParts.find((p) => p.displayName === NAME || p.partNumber.includes(NUMBER));
  expect(mine, 'the taker’s parts manifest lists the part').toBeTruthy();
  expect((await page.request.get(mine!.spriteUrl)).ok()).toBe(true);
  expect((await page.request.get(mine!.xmlUrl)).ok()).toBe(true);
});
