// Journey — a catalog item's own cover picture.
//
//   1. Olive's module is public in the catalog, with its drawn picture.
//   2. She opens "Cover picture…" on its card, uploads a picture that's
//      see-through on the left, picks a black background, zooms and saves:
//      it waits for review, and the card still shows the drawn picture.
//   3. The moderator sees the old and new pictures side by side and
//      approves; an anonymous visitor's catalog shows the new picture, black
//      where the upload was see-through.
//   4. She removes it: back to the drawn picture.

import { test, expect, type Page } from '@playwright/test';
import { ensureUser, signIn, adminSection } from '../../helpers';
import { makeGlobalAdmin, siteSettingsAtDefaults } from '../../dbHelpers';
import { watch4xx } from '../../quietNetwork';

siteSettingsAtDefaults();

test.setTimeout(180_000);
const ts = Date.now();
const ADMIN = `j-cov-admin-${ts}@example.com`;
const MOD = `j-cov-mod-${ts}@example.com`;
const OWNER = `j-cov-owner-${ts}@example.com`;
const TITLE = `Signal box ${ts}`;

async function as(page: Page, email: string, name: string) {
  await page.context().clearCookies();
  await signIn(page, email, name);
}

/** A 400 × 200 PNG: see-through on the left half, red on the right. */
async function halfClearPng(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 200;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(200, 0, 200, 200);
    return c.toDataURL('image/png').split(',')[1]!;
  });
  return Buffer.from(b64, 'base64');
}

/** The color of one pixel of an image on the page, read through a canvas. */
async function pixel(page: Page, src: string, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    async ([u, px, py]) => {
      const img = new Image();
      img.src = u as string;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return Array.from(ctx.getImageData(Math.round((px as number) * c.width), Math.round((py as number) * c.height), 1, 1).data);
    },
    [src, x, y] as const,
  );
}

test('an owner uploads a cover with a background color; it is reviewed, then shows to everyone', async ({ page }) => {
  // Nothing here asks for a picture that isn't there (a WAF bans bursts of 404s).
  const net = watch4xx(page);
  for (const [e, n] of [[ADMIN, 'Site Admin'], [MOD, 'Mo Derator'], [OWNER, 'Owner Olive']] as const) await ensureUser(e, n);
  makeGlobalAdmin(ADMIN);
  await as(page, ADMIN, 'Site Admin');
  const modId = ((await (await page.request.get('/api/admin/users?q=' + encodeURIComponent(MOD))).json()) as { users: { id: string; email: string }[] }).users.find((u) => u.email === MOD)!.id;
  expect((await page.request.patch(`/api/admin/users/${modId}`, { data: { isModerator: true } })).ok()).toBe(true);
  expect((await page.request.patch('/api/admin/settings', { data: { moduleCatalogEnabled: true, catalogReview: 'none', catalogAnonymousBrowse: true } })).ok()).toBe(true);

  // 1. Olive's module goes public (review off for the moment), then review is back on.
  await as(page, OWNER, 'Owner Olive');
  const moduleId = ((await (await page.request.post('/api/modules', { data: { title: TITLE } })).json()) as { id: string }).id;
  // Its drawn picture (the editor makes one when the module is saved).
  const drawn = (await halfClearPng(page)).toString('base64');
  expect((await page.request.put(`/api/modules/${moduleId}/thumbnail`, { data: { mime: 'image/png', data: drawn } })).ok()).toBe(true);
  expect((await page.request.post('/api/catalog/submissions', { data: { kind: 'module', sourceId: moduleId, title: TITLE } })).status()).toBe(201);
  await as(page, ADMIN, 'Site Admin');
  expect((await page.request.patch('/api/admin/settings', { data: { catalogReview: 'moderators' } })).ok()).toBe(true);

  // 2. Olive uploads her own picture.
  await as(page, OWNER, 'Owner Olive');
  await page.goto('/catalog');
  const card = page.getByTestId('catalog-item').filter({ hasText: TITLE });
  await expect(card.locator('img[src*="/cover?"]')).toHaveCount(0);
  await card.getByRole('button', { name: `${TITLE}: cover picture` }).click();
  const dlg = page.getByRole('dialog', { name: 'Cover picture' });
  await expect(dlg.getByLabel('Use the drawn picture')).toBeChecked();
  await dlg.getByLabel('Upload your own picture').check();
  await dlg.getByLabel('Cover picture').setInputFiles({ name: 'box.png', mimeType: 'image/png', buffer: await halfClearPng(page) });
  await expect(dlg.getByTestId('cover-preview')).toBeVisible();
  await expect(dlg.getByText(/see-through/)).toBeVisible();
  await dlg.getByRole('radio', { name: 'Black' }).click();
  await expect(dlg.getByRole('radio', { name: 'Black' })).toHaveAttribute('aria-checked', 'true');
  // Fit, then Fill again: it covers the card.
  await dlg.getByRole('button', { name: 'Fit' }).click();
  await dlg.getByRole('button', { name: 'Fill' }).click();
  await expect(dlg.getByText(/A moderator checks it/)).toBeVisible();
  await dlg.getByRole('button', { name: 'Save picture' }).click();
  await expect(dlg.getByRole('status')).toContainText('Sent for review');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(card.locator('img[src*="/cover?"]')).toHaveCount(0);

  // 3. The moderator sees both, and approves.
  await as(page, MOD, 'Mo Derator');
  await page.goto('/admin');
  await adminSection(page, 'moderation');
  const entry = page.getByTestId('cover-review').filter({ hasText: TITLE });
  await expect(entry.getByTestId('review-old').locator('img')).toHaveAttribute('src', /\/preview\?/);
  await expect(entry.getByTestId('review-new').locator('img')).toHaveAttribute('src', /\/cover\?image=/);
  await entry.getByRole('button', { name: `Approve the new picture for ${TITLE}` }).click();
  await expect(entry).toHaveCount(0);

  // Anyone (signed out) sees it: black where it was see-through, red on the right.
  await page.context().clearCookies();
  await page.goto('/catalog');
  const pub = page.getByTestId('catalog-item').filter({ hasText: TITLE }).getByTestId('catalog-preview');
  await expect(pub).toHaveAttribute('src', /\/cover\?image=.*size=small/);
  const src = (await pub.getAttribute('src'))!;
  const left = await pixel(page, src, 0.1, 0.5);
  const right = await pixel(page, src, 0.9, 0.5);
  expect(left[0]! + left[1]! + left[2]!).toBeLessThan(40);
  expect(right[0]!).toBeGreaterThan(200);
  expect(right[1]!).toBeLessThan(40);

  // 4. Olive removes it: back to the drawn picture, at once.
  await as(page, OWNER, 'Owner Olive');
  await page.goto('/catalog');
  await card.getByRole('button', { name: `${TITLE}: cover picture` }).click();
  await expect(dlg.getByRole('img', { name: 'Your cover picture' })).toBeVisible();
  await dlg.getByRole('button', { name: 'Remove custom picture' }).click();
  await dlg.getByRole('button', { name: 'Save picture' }).click();
  await expect(dlg.getByRole('status')).toContainText('Back to the drawn picture');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(card.locator('img[src*="/cover?"]')).toHaveCount(0);

  // Leave the catalog as other specs expect it: without this item.
  const item = ((await (await page.request.get('/api/catalog/mine')).json()) as { items: { id: string; title: string }[] }).items.find((i) => i.title === TITLE)!;
  expect((await page.request.post(`/api/catalog/items/${item.id}/withdraw`)).ok()).toBe(true);
  net.expectQuiet();
});
