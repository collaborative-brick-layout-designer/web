// Journey: Recently deleted.
//
//   Ada deletes a layout: the question says it waits 30 days in Recently
//   deleted, and the toast's Undo brings it straight back. She deletes it
//   again and a venue too: Home's Recently deleted lists both with when they
//   go for good. Restore puts the layout back in her list; Delete now erases
//   the venue after asking. Bob, signed in elsewhere, never sees her trash.
//
//   Then a module that's in two of Ada's collections: deleting it takes it
//   out of both; one collection is deleted while the module waits; Restore
//   puts the module back into the collection that's left, and the toast
//   says so, and that the other collection is gone.
//
// SHOTS=<dir> saves light and dark pictures of each step.

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { signIn } from '../../helpers';

const ts = Date.now();
const ADA = `j-trash-ada-${ts}@example.com`;
const BOB = `j-trash-bob-${ts}@example.com`;
const LAYOUT = `Freight yard ${ts}`;
const VENUE = `Town hall ${ts}`;
const SHOTS = process.env.SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`), fullPage: true });
  }
}

test('a deleted layout or venue waits in Recently deleted, and comes back', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signIn(page, ADA, 'Ada Trash');
  expect((await page.request.post('/api/layouts', { data: { title: LAYOUT } })).ok()).toBe(true);
  expect((await page.request.post('/api/venues', { data: { name: VENUE, data: { name: VENUE, edges: [], obstacles: [] } } })).ok()).toBe(true);
  await page.goto('/');
  const layoutRow = page.getByRole('button', { name: `More for ${LAYOUT}` }).first();
  await expect(layoutRow).toBeVisible();
  await expect(page.getByTestId('recently-deleted')).toHaveCount(0);

  // Delete it: the question says it can come back; Undo does that.
  const dialog = page.getByTestId('confirm-dialog');
  const deleteFromMenu = async (name: string) => {
    await page.getByRole('button', { name: `More for ${name}` }).first().click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(dialog).toContainText('It waits 30 days in Recently deleted on Home, where you can restore it.');
  };
  await deleteFromMenu(LAYOUT);
  await shot(page, 'delete-question');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  const toast = page.getByTestId('toast');
  await expect(toast).toContainText(`Deleted “${LAYOUT}”`);
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(layoutRow).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('recently-deleted')).toHaveCount(0);

  // Again, and the venue: both wait in Recently deleted.
  await deleteFromMenu(LAYOUT);
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(layoutRow).toHaveCount(0, { timeout: 10000 });
  await deleteFromMenu(VENUE);
  await dialog.getByRole('button', { name: 'Delete' }).click();
  const trash = page.getByTestId('recently-deleted');
  await expect(trash).toContainText('Recently deleted (2)');
  await trash.getByText(/Recently deleted/).click();
  await expect(trash).toContainText(LAYOUT);
  await expect(trash).toContainText(VENUE);
  await expect(trash).toContainText('gone for good on');
  await shot(page, 'recently-deleted');

  // Bob never sees Ada's.
  const bobCtx = await browser.newContext();
  const bob = await bobCtx.newPage();
  await signIn(bob, BOB, 'Bob Trash');
  await bob.goto('/');
  await expect(bob.getByRole('heading', { name: 'Layouts' })).toBeVisible();
  await expect(bob.getByTestId('recently-deleted')).toHaveCount(0);
  await bobCtx.close();

  // Restore the layout: back in the list, gone from here.
  await trash.locator('li', { hasText: LAYOUT }).getByRole('button', { name: 'Restore' }).click();
  await expect(layoutRow).toBeVisible({ timeout: 10000 });
  await expect(trash).toContainText('Recently deleted (1)');
  // Delete the venue now, after asking.
  await trash.locator('li', { hasText: VENUE }).getByRole('button', { name: 'Delete now' }).click();
  await expect(dialog.getByRole('heading')).toHaveText(`Delete “${VENUE}” for good?`);
  await dialog.getByRole('button', { name: 'Delete now' }).click();
  await expect(page.getByTestId('recently-deleted')).toHaveCount(0, { timeout: 10000 });
});

test('a restored module goes back into its collections, and says which are gone', async ({ page }) => {
  test.setTimeout(120_000);
  const ADA2 = `j-trash-coll-${ts}@example.com`;
  const MODULE = `Siding ${ts}`;
  const KEPT = `Yard picks ${ts}`;
  const GONE = `Old picks ${ts}`;
  await signIn(page, ADA2, 'Ada Curator');
  const module = ((await (await page.request.post('/api/modules', { data: { title: MODULE } })).json()) as { id: string }).id;
  const collection = async (title: string) => {
    const r = await page.request.post('/api/catalog/collections', {
      data: { title, audience: 'private', entries: [{ source: 'library', kind: 'module', id: module }] },
    });
    expect(r.status()).toBe(201);
    return ((await r.json()) as { id: string }).id;
  };
  const kept = await collection(KEPT);
  const gone = await collection(GONE);
  const inKept = async () => (((await (await page.request.get(`/api/catalog/collections/${kept}`)).json()) as { items: { id: string }[] }).items.map((i) => i.id));
  expect(await inKept()).toEqual([module]);

  // Delete the module from Home: it leaves both collections.
  await page.goto('/');
  await page.getByRole('button', { name: `More for ${MODULE}` }).first().click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toContainText('it leaves any collections it was in');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('button', { name: `More for ${MODULE}` })).toHaveCount(0, { timeout: 10000 });
  expect(await inKept()).toEqual([]);
  // One of its collections is deleted while the module waits.
  expect((await page.request.delete(`/api/catalog/collections/${gone}`)).ok()).toBe(true);

  // Restore: back in the collection that's left, and the toast says so.
  const trash = page.getByTestId('recently-deleted');
  await expect(trash).toContainText('Recently deleted (1)');
  await trash.getByText(/Recently deleted/).click();
  await trash.locator('li', { hasText: MODULE }).getByRole('button', { name: 'Restore' }).click();
  const toast = page.getByTestId('toast');
  await expect(toast).toContainText(
    `Restored “${MODULE}”. It’s back in “${KEPT}”. The other collection it was in has been deleted since, so it isn’t in that one.`,
  );
  await shot(page, 'restored-into-collection');
  await expect(page.getByRole('button', { name: `More for ${MODULE}` }).first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('recently-deleted')).toHaveCount(0);
  expect(await inKept()).toEqual([module]);
});
