// Journey — deleting things, each through the one confirmation dialog.
//
// Dee has her Home page open in two browsers. In the first she deletes a
// layout (typing its name), a module, a venue, a custom part and a
// collection. Each time the dialog says what goes and what stays, Cancel
// keeps it, Delete removes it and says "Deleted ‹name›", and it drops off
// the second browser's page without a reload (the live stream).

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { signIn } from '../../helpers';
import { makeGlobalAdmin, siteSettingsAtDefaults } from '../../dbHelpers';
import { watch4xx } from '../../quietNetwork';

siteSettingsAtDefaults();

const ts = Date.now();
test.setTimeout(180_000);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const XML = Buffer.from('<?xml version="1.0"?><part><Author>e2e</Author></part>').toString('base64');

async function browserFor(browser: Browser, email: string, name: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await signIn(page, email, name);
  return { ctx, page };
}

async function post(page: Page, url: string, data: object): Promise<{ id: string }> {
  const res = await page.request.post(url, { data });
  expect(res.ok(), `${url}: ${res.status()} ${await res.text()}`).toBe(true);
  return res.json() as Promise<{ id: string }>;
}

const streamOpen = (page: Page) => expect(page.locator('html')).toHaveAttribute('data-live', 'open', { timeout: 15000 });

test('a layout, a module, a venue, a part and a collection are deleted through the dialog, and leave the other browser live', async ({ browser }) => {
  const EMAIL = `j-delete-${ts}@example.com`;
  const one = await browserFor(browser, EMAIL, 'Dee Leter');
  makeGlobalAdmin(EMAIL);
  const two = await browserFor(browser, EMAIL, 'Dee Leter');
  try {
    expect((await one.page.request.patch('/api/admin/settings', { data: { moduleCatalogEnabled: true } })).ok()).toBe(true);
    const LAYOUT = `Old yard ${ts}`;
    const MODULE = `Old shed ${ts}`;
    const VENUE = `Old hall ${ts}`;
    const PART = `OLD${ts}`;
    const COLLECTION = `Old picks ${ts}`;
    await post(one.page, '/api/layouts', { title: LAYOUT });
    const mod = await post(one.page, '/api/modules', { title: MODULE });
    await post(one.page, '/api/venues', { name: VENUE, data: { name: VENUE, enabled: true, minWalkwayStuds: 30, bounds: { x: 0, y: 0, w: 10, h: 10 }, edges: [], obstacles: [] } });
    await post(one.page, '/api/custom-parts', { partNumber: PART, displayName: 'Old arch', xmlBase64: XML, spriteBase64: PNG, spriteMime: 'image/png' });
    await post(one.page, '/api/catalog/collections', {
      title: COLLECTION,
      description: '',
      entries: [{ source: 'library', kind: 'module', id: mod.id }],
      coverItemId: null,
      audience: 'private',
    });

    // Neither browser asks again for what was deleted (a 404 burst a WAF would ban).
    const net = [watch4xx(one.ctx), watch4xx(two.ctx)];
    for (const p of [one.page, two.page]) {
      await p.goto('/');
      await streamOpen(p);
      for (const text of [LAYOUT, MODULE, VENUE, PART, COLLECTION]) await expect(p.getByText(text).first()).toBeVisible({ timeout: 15000 });
    }

    const dialog = one.page.getByTestId('confirm-dialog');
    /** Open the dialog, check it, Cancel (still there), open again, Delete. */
    const deleteIt = async (open: () => Promise<void>, name: string, says: string, typeName = false) => {
      await open();
      await expect(dialog.getByRole('heading')).toHaveText(`Delete “${name}”?`);
      await expect(dialog).toContainText(says);
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await one.page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await open();
      if (typeName) {
        await expect(dialog.getByRole('button', { name: 'Delete' })).toBeDisabled();
        await dialog.getByLabel(`Type ${name} to confirm`).fill(name);
      }
      await dialog.getByRole('button', { name: 'Delete' }).click();
      await expect(one.page.getByTestId('toast')).toContainText(`Deleted “${name}”`);
      // Gone here, and in the other browser without a reload.
      await expect(one.page.getByText(name, { exact: true })).toHaveCount(0, { timeout: 10000 });
      await expect(two.page.getByText(name, { exact: true })).toHaveCount(0, { timeout: 10000 });
    };
    const fromMenu = (label: string) => async () => {
      await one.page.getByRole('button', { name: `More for ${label}` }).first().click();
      await one.page.getByRole('menuitem', { name: 'Delete' }).click();
    };

    await deleteIt(fromMenu(LAYOUT), LAYOUT, 'its share links are deleted');
    // The collection first: deleting the module would take it out of the collection.
    await one.page.goto('/catalog?kind=collections');
    await streamOpen(one.page);
    await two.page.goto('/catalog?kind=collections');
    await streamOpen(two.page);
    await deleteIt(async () => one.page.getByRole('button', { name: `Delete ${COLLECTION}` }).click(), COLLECTION, 'Its modules and parts aren’t deleted');
    await one.page.goto('/');
    await streamOpen(one.page);
    await two.page.goto('/');
    await streamOpen(two.page);
    await deleteIt(fromMenu(MODULE), MODULE, 'Layouts that already use it don’t change.');
    await deleteIt(fromMenu(VENUE), VENUE, 'Layouts made from it keep their own copy');
    await deleteIt(fromMenu(PART), PART, 'show a placeholder');
    await one.page.waitForTimeout(1000);
    for (const n of net) n.expectQuiet();
  } finally {
    await one.ctx.close();
    await two.ctx.close();
  }
});
