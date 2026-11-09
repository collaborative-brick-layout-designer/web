// Aaron's approved proposals (2026-10-06), end to end:
// - Duplicate (Ctrl+D) and paste of exactly one picked module make a real
//   module, "X (copy)", with the original's colors, not linked or pinned.
// - The Modules panel's Delete deletes the module's parts (Ungroup keeps them).
// - Undo brings them back picked, as BlueBrick does.
// - A phone reaches Download & export, Insert and the venue designer from
//   the layout-name menu.

import { test, expect, devices, type Page } from '@playwright/test';
import { signIn, makeModule, confirmInDialog } from '../helpers';

const PART = 'ts_narrowgauge_straight.8';

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: { name: () => string; getClassName: () => string }) => boolean) => unknown[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

interface Mod { name: string; members: string[]; outlineColor?: string; pinned?: boolean; libraryModuleId?: string }
async function modules(page: Page, id: string): Promise<Mod[]> {
  const r = await page.request.get(`/api/layouts/${id}/export.bbm.bld`);
  return r.ok() ? (((await r.json()) as { modules?: Mod[] }).modules ?? []) : [];
}

test('a picked module duplicates and pastes as a module copy; Delete deletes its parts; Undo picks them again', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `modcopy-${Date.now()}@example.com`, 'Module Copier');
  const res = await page.request.post('/api/layouts', { data: { title: 'Module copies' } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  for (let i = 0; i < 2; i++) {
    await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
    await page.locator(`[title*="(${PART})"]`).first().dblclick();
  }
  await expect.poll(() => brickCount(page)).toBe(2);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+a');
  await makeModule(page, 'Siding');
  await expect.poll(async () => (await modules(page, id)).length, { timeout: 10000 }).toBe(1);

  // Ctrl+A picks the module whole; Ctrl+D makes "Siding (copy)", picked.
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+d');
  await expect.poll(() => brickCount(page)).toBe(4);
  await expect.poll(async () => (await modules(page, id)).map((m) => m.name).sort(), { timeout: 10000 }).toEqual(['Siding', 'Siding (copy)']);
  const copy = (await modules(page, id)).find((m) => m.name === 'Siding (copy)')!;
  expect(copy.members).toHaveLength(2);
  expect(copy.pinned).toBeUndefined();
  expect(copy.libraryModuleId).toBeUndefined();
  await expect(page.locator('footer')).toContainText('selected: 2');

  // Ctrl+C, Ctrl+V of the picked copy: another module copy.
  await page.keyboard.press('Control+c');
  await page.mouse.move(300, 300);
  await page.keyboard.press('Control+v');
  await expect.poll(() => brickCount(page)).toBe(6);
  await expect.poll(async () => (await modules(page, id)).map((m) => m.name).sort(), { timeout: 10000 }).toEqual(['Siding', 'Siding (copy)', 'Siding (copy) (copy)']);

  // Modules panel: Delete deletes Siding's parts, after a question.
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel('Modules', { exact: true }).check();
  await page.mouse.click(400, 400);
  await page.getByText('Siding', { exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).last().click();
  await expect(page.getByTestId('confirm-dialog')).toContainText('its 2 parts leave the map');
  await confirmInDialog(page);
  await expect.poll(() => brickCount(page)).toBe(4);
  await expect.poll(async () => (await modules(page, id)).map((m) => m.name).sort(), { timeout: 10000 }).toEqual(['Siding (copy)', 'Siding (copy) (copy)']);

  // Undo: the module and its parts come back, picked.
  await page.mouse.click(400, 400);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect.poll(() => brickCount(page)).toBe(6);
  await expect(page.locator('footer')).toContainText('selected: 2');
});

test.describe('the Map menu on a phone', () => {
  const { defaultBrowserType: _p, ...pixel7 } = devices['Pixel 7'];
  test.use(pixel7);

  test('the layout-name menu opens it: Download & export, and Insert while editing', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'touch emulation');
    await signIn(page, `phonemap-${Date.now()}@example.com`, 'Phone Map');
    const res = await page.request.post('/api/layouts', { data: { title: 'Phone map' } });
    const { id } = (await res.json()) as { id: string };
    await page.goto(`/editor/${id}`);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    const openMap = async () => {
      await page.getByRole('button', { name: /Phone map/ }).first().tap();
      await page.getByTestId('phone-map').tap();
    };

    // Viewing: Download & export only.
    await openMap();
    const sheet = page.getByRole('menu').last();
    await expect(sheet.getByRole('menuitem', { name: 'Download & export' })).toBeVisible();
    await expect(sheet.getByRole('menuitem', { name: 'Insert' })).toHaveCount(0);
    await sheet.getByRole('menuitem', { name: 'Download & export' }).tap();
    await page.getByRole('menu').last().getByRole('menuitem', { name: 'Download as…' }).tap();
    await expect(page.getByRole('dialog', { name: 'Download As' })).toBeVisible();
    await page.getByRole('dialog', { name: 'Download As' }).getByRole('button', { name: 'Cancel' }).tap();

    // Editing: Insert ▸ Text… and the Venue ▸ entries too.
    await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
    await openMap();
    await expect(page.getByRole('menu').last().getByRole('menuitem', { name: 'Venue' })).toBeVisible();
    await page.getByRole('menu').last().getByRole('menuitem', { name: 'Insert' }).tap();
    await page.getByRole('menu').last().getByRole('menuitem', { name: 'Text…' }).tap();
    await expect(page.getByRole('dialog', { name: 'Add text' })).toBeVisible();
  });
});
