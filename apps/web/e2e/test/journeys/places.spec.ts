// Places (Live Ops Phase 1): name a cannery on a piece of track, see how
// many cars it holds and its bracket on the map, make the track a module
// (the place goes with it), save the module to the Module library (its row
// says so) and add it to another layout, where the cannery is. Undo, the
// View tick, right-click on track, and the phone's sheet.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, devices, type Page } from '@playwright/test';
import { makeModule, mapMenu, signIn } from '../../helpers';

const BBM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures/tight-corner.bbm'), 'utf-8');
/** A stub of 9V track in tight-corner.bbm: 96 studs from (456, 144) down to (456, 240), open at both ends. */
const STUB = { x: 456, top: 144 };

function onPage(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([sx, sy]) => {
      type St = { getAbsoluteTransform: () => { point: (p: { x: number; y: number }) => { x: number; y: number } }; container: () => HTMLElement };
      const st = (window as unknown as { Konva: { stages: St[] } }).Konva.stages[0]!;
      const p = st.getAbsoluteTransform().point({ x: sx! * 8, y: sy! * 8 });
      const box = st.container().getBoundingClientRect();
      return { x: box.left + p.x, y: box.top + p.y };
    },
    [x, y],
  );
}

/** The words of every place label on the map. */
function labels(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string; text?: () => string; find: (f: (n: N) => boolean) => N[] };
    const st = (window as unknown as { Konva: { stages: N[] } }).Konva.stages[0]!;
    return st.find((x) => x.name() === 'place-label').map((l) => l.find((t) => t.getClassName() === 'Text')[0]!.text!());
  });
}

async function newLayout(page: Page, title: string, bbm?: string): Promise<string> {
  const { id } = (await (await page.request.post('/api/layouts', { data: { title, ...(bbm ? { bbm } : {}) } })).json()) as { id: string };
  return id;
}

test('a cannery named on a module goes along to the Module library and to another layout', async ({ page }) => {
  test.setTimeout(150_000);
  const stamp = Date.now();
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `places-${stamp}@example.com`, 'Place Namer');
  await page.goto(`/editor/${await newLayout(page, 'Cannery', BBM)}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.keyboard.press('f');

  // New place, then the stub's track.
  await mapMenu(page, 'Modules & sets', 'Places…');
  const panel = page.getByTestId('places-panel');
  await expect(panel).toContainText('No places yet.');
  await panel.getByTestId('place-new').click();
  await expect(page.getByTestId('place-pick-banner')).toContainText('click the track where cars stand');
  await page.waitForTimeout(200);
  const at = await onPage(page, STUB.x, STUB.top + 48);
  await page.mouse.click(at.x, at.y);
  const editor = page.getByTestId('place-editor');
  await expect(editor.getByTestId('spot-capacity')).toHaveText('3 cars (from the track’s length)');
  await editor.getByTestId('place-name').fill('Acme Cannery');
  await editor.getByTestId('place-name').press('Enter');
  await editor.getByTestId('place-accepts').getByPlaceholder('Add…').fill('reefer');
  await editor.getByTestId('place-accepts').getByPlaceholder('Add…').press('Enter');
  await expect.poll(() => labels(page)).toEqual(['Acme Cannery\n3 cars']);

  // Typed capacity wins, at once, on the map too; undo takes it back.
  // (Edits within 0.2 s of each other are one undo step: wait for this one to be its own.)
  await page.waitForTimeout(400);
  await editor.getByTestId('spot-cars').fill('2');
  await editor.getByTestId('spot-cars').press('Enter');
  await expect(editor.getByTestId('spot-capacity')).toHaveText('2 cars');
  await expect.poll(() => labels(page)).toEqual(['Acme Cannery\n2 cars']);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+z');
  await expect.poll(() => labels(page)).toEqual(['Acme Cannery\n3 cars']);

  // View › Places off and on.
  await mapMenu(page, 'View', 'Places');
  await expect.poll(() => labels(page)).toEqual([]);
  await mapMenu(page, 'View', 'Places');
  await expect.poll(() => labels(page)).toEqual(['Acme Cannery\n3 cars']);

  // Made a module: the place is the module's now.
  await editor.getByTestId('place-back').click();
  await expect(panel.getByRole('region', { name: 'This layout' })).toContainText('Acme Cannery');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+a');
  await makeModule(page, `Depot ${stamp}`);
  await expect(panel.getByRole('region', { name: `Depot ${stamp}` })).toContainText('Acme Cannery');

  // Saved to the Module library: its row says "1 industry".
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel('Modules', { exact: true }).check();
  await page.mouse.click(400, 400);
  await expect(page.getByTestId('module-places-note')).toHaveText('1 industry');
  await page.getByRole('button', { name: `More for Depot ${stamp}` }).click();
  await page.getByRole('menuitem', { name: 'Save to Module library…' }).click();
  await page.getByRole('dialog', { name: `Save “Depot ${stamp}” to the Module library` }).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(`Saved “Depot ${stamp}” to the Module library`)).toBeVisible({ timeout: 15000 });
  // (It is linked now: its menu's Places… shows only its places.)
  await page.getByRole('button', { name: `More for Depot ${stamp}` }).click();
  await page.getByTestId('module-menu-places').click();
  await expect(panel).toContainText(`Places on Depot ${stamp}`);

  // Another layout, with the same sheets: the module brings its cannery.
  const other = await newLayout(page, 'Second layout', BBM);
  await page.goto(`/editor/${other}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel('Modules', { exact: true }).uncheck();
  await page.getByLabel('Places', { exact: true }).uncheck();
  await page.getByLabel('Module library', { exact: true }).check();
  await page.mouse.click(400, 400);
  const libRow = page.getByTestId('module-library-row').filter({ hasText: `Depot ${stamp}` });
  await expect(libRow.getByTestId('module-library-places')).toHaveText('1 industry');
  await libRow.getByRole('button', { name: 'Add to layout' }).click();
  await expect.poll(async () => (await labels(page)).some((t) => t.startsWith('Acme Cannery\n')), { timeout: 20000 }).toBe(true);
  await mapMenu(page, 'Modules & sets', 'Places…');
  await panel.getByRole('button', { name: 'Acme Cannery' }).click();
  await expect(editor).toContainText(`On Depot ${stamp}`);
  await expect(editor.getByTestId('place-accepts')).toContainText('reefer');
  await expect(editor.getByTestId('spot-capacity')).toContainText('cars');

  // Home says so too.
  await page.goto('/');
  await expect(page.getByTestId('module-row').filter({ hasText: `Depot ${stamp}` }).getByTestId('module-row-places')).toHaveText('1 industry');
});

test('right-click on track makes a place; deleting it and its track says so plainly', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `places-menu-${Date.now()}@example.com`, 'Place Namer');
  await page.goto(`/editor/${await newLayout(page, 'Right-click', BBM)}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.keyboard.press('f');
  const at = await onPage(page, STUB.x, STUB.top + 8);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.getByRole('button', { name: 'Make a place…' }).or(page.getByRole('menuitem', { name: 'Make a place…' })).click();
  const editor = page.getByTestId('place-editor');
  await expect(editor.getByTestId('place-name')).toHaveValue('Place 1');
  // Its track goes: the spot says what to do, and Pick its track mends it.
  await page.mouse.click(at.x, at.y);
  await page.keyboard.press('Delete');
  await expect(editor.getByTestId('spot-capacity')).toContainText('Its track was moved or removed. Pick it again.');
  await editor.getByTestId('spot-pick').click();
  await expect(page.getByTestId('place-pick-banner')).toBeVisible();
  // (The map takes clicks for it from its next frame.)
  await page.waitForTimeout(200);
  const there = await onPage(page, STUB.x, STUB.top + 80);
  await page.mouse.click(there.x, there.y);
  await expect(editor.getByTestId('spot-capacity')).toContainText('from the track’s length');
  // Deleted, and undone.
  await page.waitForTimeout(400);
  await editor.getByTestId('place-delete').click();
  await page.getByRole('alertdialog').or(page.getByRole('dialog')).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByTestId('places-panel')).toContainText('No places yet.');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('places-panel')).toContainText('Place 1');
});

test.describe('on a phone', () => {
  const { defaultBrowserType: _browser, ...phone } = devices['Pixel 7'];
  test.use(phone);

  test('the Places sheet names a place by touch', async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page, `places-phone-${Date.now()}@example.com`, 'Phone Namer');
    await page.goto(`/editor/${await newLayout(page, 'Phone places', BBM)}`);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(1500);
    await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
    const open = async () => {
      await page.getByRole('button', { name: /Phone places/ }).first().tap();
      await page.getByTestId('phone-map').tap();
      await page.getByRole('menuitem', { name: 'Places…' }).tap();
    };
    await open();
    const sheet = page.getByRole('dialog', { name: 'Places' });
    await sheet.getByTestId('place-new').tap();
    await expect(sheet).toHaveCount(0);
    await page.waitForTimeout(200);
    const at = await onPage(page, STUB.x, STUB.top + 48);
    await page.touchscreen.tap(at.x, at.y);
    await expect(sheet.getByTestId('place-editor')).toBeVisible();
    await sheet.getByTestId('place-name').fill('Mill');
    await sheet.getByTestId('place-name').press('Enter');
    await sheet.getByTestId('place-back').tap();
    await expect(sheet.locator('[data-place]')).toContainText('Mill');
    // Nothing is wider than the phone.
    expect(await sheet.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
});
