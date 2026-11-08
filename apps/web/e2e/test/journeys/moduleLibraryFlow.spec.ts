// Journey: a module is made for one layout, then shared through the
// library, and the copies stay in step both ways.
//
//   1. Robin picks three parts and makes them a module, "Yard": it's in
//      this layout only, nothing goes to the Module library.
//   2. From the module's right-click menu on the map: Save to Module library….
//      The Modules panel says it's in the Module library, version 1.
//   3. A second layout adds Yard from the Module library: it's linked too.
//   4. Back in the first layout, Robin adds a part to Yard (Edit module)
//      and uses Update Module library version, with a note: version 2.
//   5. The second layout offers Update from Module library (v2) and brings the
//      new part in without asking (its copy wasn't changed).
//   6. Robin changes the second layout's copy, the Module library gets version 3,
//      and Update from Module library asks first; Cancel keeps the copy as it is.
// SHOTS=<dir> saves pictures of the dialogs, light and dark.

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { signIn, makeModule } from '../../helpers';

const ts = Date.now();
const PART = 'ts_narrowgauge_straight.8';
const NAME = `Yard ${ts % 10000}`;
const SHOTS = process.env.SHOTS;

interface Brick {
  id: string;
  sx: number;
  sy: number;
}

function bricks(page: Page): Promise<Brick[]> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string; getAbsolutePosition: () => { x: number; y: number } };
    const st = (window as unknown as { Konva?: { stages: { container: () => HTMLElement; find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    if (!st) return [];
    const box = st.container().getBoundingClientRect();
    return st
      .find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-'))
      .map((n) => {
        const a = n.getAbsolutePosition();
        return { id: n.name().slice(6), sx: box.left + a.x, sy: box.top + a.y };
      });
  });
}

async function placePart(page: Page): Promise<void> {
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function openLayout(page: Page, title: string): Promise<string> {
  const { id } = (await (await page.request.post('/api/layouts', { data: { title } })).json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  return id;
}

/** The Modules panel's row for the module. */
async function moduleRow(page: Page) {
  if (!(await page.getByTestId('module-more').first().isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Panels', exact: true }).click();
    await page.getByLabel('Modules', { exact: true }).check();
    await page.mouse.click(700, 820);
  }
  return page.locator('li').filter({ has: page.getByRole('button', { name: `More for ${NAME}` }) });
}

async function moduleMenu(page: Page, entry: string | RegExp) {
  const row = await moduleRow(page);
  await row.getByRole('button', { name: `More for ${NAME}` }).click();
  await page.getByRole('button', { name: entry }).click();
}

test('make a module, save it to the Module library, and keep the copies in step both ways', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `modflow-${ts}@example.com`, 'Robin');

  // 1. Make a module: this layout only.
  const first = await openLayout(page, 'Show layout');
  for (let i = 0; i < 3; i++) await placePart(page);
  await expect.poll(async () => (await bricks(page)).length).toBe(3);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+a');
  await makeModule(page, NAME);
  await expect(page.getByText(`“${NAME}” is a module in this layout`)).toBeVisible();
  const library = async () => ((await (await page.request.get('/api/modules')).json()) as { modules: { id: string; title: string; latestVersion?: number }[] }).modules;
  expect((await library()).some((m) => m.title === NAME)).toBe(false);

  // 2. Right-click it on the map: Save to Module library….
  await page.keyboard.press('Escape');
  const parts = await bricks(page);
  await page.mouse.click(parts[0]!.sx, parts[0]!.sy, { button: 'right' });
  await page.getByRole('button', { name: 'Save to Module library…' }).click();
  const save = page.getByRole('dialog', { name: `Save “${NAME}” to the Module library` });
  await expect(save.getByLabel('Module name')).toHaveValue(NAME);
  await shot(page, 'save-to-library');
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText(`Saved “${NAME}” to the Module library`)).toBeVisible({ timeout: 15000 });
  const saved = (await library()).find((m) => m.title === NAME)!;
  expect(saved.latestVersion).toBe(1);
  await expect((await moduleRow(page)).getByTestId('module-library-note')).toHaveText('in the Module library v1');

  // 3. A second layout adds it from the Module library: linked too.
  const second = await openLayout(page, 'Club table');
  await page.getByRole('button', { name: 'Insert module' }).click();
  await page.locator('li', { hasText: NAME }).getByRole('button', { name: 'Insert' }).click();
  await expect.poll(async () => (await bricks(page)).length).toBe(3);
  await expect((await moduleRow(page)).getByTestId('module-library-note')).toHaveText('in the Module library v1');

  // 4. The first layout: a part joins Yard, then Update Module library version.
  await page.goto(`/editor/${first}`);
  await expect.poll(async () => (await bricks(page)).length, { timeout: 15000 }).toBe(3);
  await moduleMenu(page, 'Edit module');
  await placePart(page);
  await expect.poll(async () => (await bricks(page)).length).toBe(4);
  await page.getByTestId('module-edit-bar').getByRole('button', { name: 'Done' }).click();
  await moduleMenu(page, 'Update Module library version…');
  const publish = page.getByRole('dialog', { name: 'Update Module library version' });
  await expect(publish).toContainText(`become version 2 of ${NAME}`);
  await publish.getByLabel('What changed? (optional)').fill('A longer siding');
  await shot(page, 'update-library-version');
  await publish.getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByText(`Saved “${NAME}” to the Module library as version 2`)).toBeVisible({ timeout: 15000 });
  await expect((await moduleRow(page)).getByTestId('module-library-note')).toHaveText('in the Module library v2');
  const versions = (await (await page.request.get(`/api/modules/${saved.id}/versions`)).json()) as { versions: { version: number; note: string }[] };
  expect(versions.versions[0]).toMatchObject({ version: 2, note: 'A longer siding' });

  // 5. The second layout: Update from Module library (v2), no question asked.
  await page.goto(`/editor/${second}`);
  await expect.poll(async () => (await bricks(page)).length, { timeout: 15000 }).toBe(3);
  await expect((await moduleRow(page)).getByTestId('module-library-note')).toHaveText('in the Module library v1 · v2 is newer');
  await moduleMenu(page, 'Update from Module library (v2)');
  await expect.poll(async () => (await bricks(page)).length).toBe(4);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect((await moduleRow(page)).getByTestId('module-library-note')).toHaveText('in the Module library v2');

  // 6. Its copy changes here (a part goes), the Module library gets version 3:
  //    Update from Module library asks first, and Cancel keeps the copy.
  await moduleMenu(page, 'Edit module');
  const now = await bricks(page);
  await page.mouse.click(now[3]!.sx, now[3]!.sy);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await bricks(page)).length).toBe(3);
  await page.getByTestId('module-edit-bar').getByRole('button', { name: 'Done' }).click();
  const bytes = await page.request.get(`/api/modules/${saved.id}/snapshot`);
  expect((await page.request.put(`/api/modules/${saved.id}/snapshot?note=Third`, {
    data: Buffer.from(await bytes.body()),
    headers: { 'content-type': 'application/octet-stream' },
  })).ok()).toBe(true);
  await page.reload();
  await expect.poll(async () => (await bricks(page)).length, { timeout: 15000 }).toBe(3);
  await moduleMenu(page, 'Update from Module library (v3)');
  const ask = page.getByRole('alertdialog', { name: `Replace “${NAME}” with version 3?` });
  await expect(ask).toBeVisible();
  await shot(page, 'update-from-library-ask');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toHaveCount(0);
  expect((await bricks(page)).length).toBe(3);
  await expect((await moduleRow(page)).getByTestId('module-library-note')).toHaveText('in the Module library v2 · v3 is newer');
});
