// Journey — a set of your own, made on the website.
//
//   Pick two parts → Map ▸ Modules & sets ▸ Save selection as set… saves
//   them to your custom parts (not under the number of a part inside it) →
//   the set is in the Parts panel straight away (no refresh) → it places as
//   one group of its two parts → right-click ▸ Rename set… → right-click ▸
//   Delete set…, which says the layouts that use it keep their parts.

import { test, expect, type Page } from '@playwright/test';
import { mapMenu, signIn } from '../../helpers';
import { expectAccessible } from '../../a11y';

const ts = Date.now();
const PART = 'ts_narrowgauge_straight.8';
const SET = `Siding set ${ts}`;
const RENAMED = `Yard set ${ts}`;

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

test('save a selection as a set, place it, rename it and delete it', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, `j-sets-${ts}@example.com`, 'Set Sam');
  const res = await page.request.post('/api/layouts', { data: { title: 'Set journey' } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  const filter = page.getByPlaceholder('Search parts (name or number)').first();
  for (let i = 0; i < 2; i++) {
    await filter.fill('narrow gauge track straight 4 x 16');
    await page.locator(`[title*="(${PART})"]`).first().dblclick();
  }
  await expect.poll(() => brickCount(page)).toBe(2);

  // ── Save the two parts as a set, to your custom parts. ──
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+a');
  await mapMenu(page, 'Modules & sets', 'Save selection as set…');
  const dialog = page.getByRole('dialog', { name: 'Save selection as set' });
  await expect(dialog).toContainText('A set is a group of parts saved together, to place again in one go.');
  await expect(dialog).toContainText('2 parts selected.');
  await expect(dialog.getByRole('button', { name: 'Download .set.xml' })).toBeEnabled();
  await expectAccessible(page, 'Save selection as set', { include: '[role=dialog][aria-label="Save selection as set"]' });
  // A set can't be named like a part inside it: placing it would nest copies of itself.
  await dialog.getByLabel('Set name').fill(PART);
  await dialog.getByRole('button', { name: 'Save set' }).click();
  await expect(dialog.getByRole('alert')).toContainText('is a part in this set, so the set can’t have that name too');
  await dialog.getByLabel('Set name').fill(SET);
  await dialog.getByRole('button', { name: 'Save set' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(`Saved the set “${SET}”`)).toBeVisible();

  // ── It's in the Parts panel without a refresh, and places as one group. ──
  await filter.fill(SET);
  const tile = page.locator('aside li button[draggable="true"]').filter({ hasText: SET }).first();
  await expect(tile).toBeVisible({ timeout: 15000 });
  await tile.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('footer')).toContainText(`Placed set: ${SET} (2 parts)`);
  await expect.poll(() => brickCount(page)).toBe(4);
  const bbm = async () => (await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text());
  await expect.poll(async () => [...(await bbm()).matchAll(/<Group id="/g)].length).toBe(1);

  // It's one of your custom parts, as a set.
  const mine = async () => ((await (await page.request.get('/api/custom-parts')).json()) as { parts: { displayName: string; kind?: string; partNumber: string }[] }).parts;
  expect((await mine()).find((p) => p.displayName === SET)).toMatchObject({ kind: 'set', partNumber: SET });

  // ── Rename it from the Parts panel. ──
  await tile.click({ button: 'right' });
  await page.getByRole('button', { name: 'Rename set…' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename set' });
  await rename.getByLabel('Name').fill(RENAMED);
  await rename.getByRole('button', { name: 'Rename' }).click();
  await expect(rename).toHaveCount(0);
  await filter.fill(RENAMED);
  const renamed = page.locator('aside li button[draggable="true"]').filter({ hasText: RENAMED }).first();
  await expect(renamed).toBeVisible({ timeout: 15000 });
  expect((await mine()).find((p) => p.partNumber === SET)?.displayName).toBe(RENAMED);

  // ── Delete it: the layouts that use it keep their parts. ──
  await renamed.click({ button: 'right' });
  await page.getByRole('button', { name: 'Delete set…' }).click();
  const confirm = page.getByTestId('confirm-dialog');
  await expect(confirm).toContainText('Layouts that use it keep the parts it put down.');
  await confirm.getByRole('button').last().click();
  await expect(page.getByText(`Deleted “${RENAMED}”`)).toBeVisible();
  await expect(renamed).toHaveCount(0);
  expect((await mine()).some((p) => p.partNumber === SET)).toBe(false);
  await expect.poll(() => brickCount(page)).toBe(4);
});
