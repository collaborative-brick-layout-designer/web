// Waybills, jobs and switch lists (Live Ops Phase 3), on the 96-stud stub of
// 9V track in tight-corner.bbm: two cars at two places. Make waybills sends
// each to the other place; until there are jobs, both are under Can't
// route. Two jobs take one each; a second browser sees the lists change as
// a car is dragged there and delivered. The place is deleted (the dialog
// says what names it), nothing is lost, and Undo brings it back. Then the
// same panel on a phone.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { mapMenu, signIn } from '../../helpers';

const BBM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures/tight-corner.bbm'), 'utf-8');
const place = (id: string, brick: string, capacity: number, ships: string[], accepts: string[]) => ({ id, name: id === 'cannery' ? 'Acme Cannery' : 'Mill', kind: 'industry', spots: [{ id: 's1', name: 'Dock', track: { brick, from: 0, to: 1 }, capacity }], accepts, ships, tags: [], notes: '' });
const car = (id: string, number: string, type: string) => ({ id, number, name: '', kind: 'car', type, trackKind: 'rail', length: 20, width: 6, bodyLength: 18, trucks: [{ at: 5, swivelMax: 30 }, { at: -5, swivelMax: 30 }], opsCut: `cut-${id}` });
const cut = (id: string, brick: string) => ({ id: `cut-${id}`, name: '', cut: true, units: [{ stock: id, reversed: false }], position: { brick, from: 0, to: 1, s: 8, facing: 'to' }, over: {}, color: '#B40000', speed: 40, trackKind: 'rail' });
const SIDECAR = JSON.stringify({
  schemaVersion: 1,
  bbmHashSha256: '',
  layoutPlaces: [place('cannery', '141', 1, ['boxcar'], ['tank']), place('mill', '322', 2, ['tank'], ['Boxcar'])],
  rollingStock: [car('c1', '101', 'Boxcar'), car('c2', '102', 'Tank')],
  trains: [cut('c1', '1372'), cut('c2', '1339')],
});

async function newLayout(page: Page, title: string): Promise<string> {
  return ((await (await page.request.post('/api/layouts', { data: { title, bbm: BBM, sidecar: SIDECAR } })).json()) as { id: string }).id;
}

type N = { name: () => string; id: () => string; x: () => number; y: () => number; find: (f: (n: N) => boolean) => N[] };
function cars(page: Page): Promise<Record<string, { x: number; y: number }>> {
  return page.evaluate(() => {
    const st = (window as unknown as { Konva?: { stages: N[] } }).Konva?.stages[0];
    return st ? Object.fromEntries(st.find((n) => n.name() === 'car-hit').map((n) => [n.id(), { x: n.x() / 8, y: n.y() / 8 }])) : {};
  });
}
async function dragCar(page: Page, id: string, dy: number) {
  const at = (await cars(page))[id]!;
  const on = (y: number) =>
    page.evaluate(([sx, sy]) => {
      type St = { getAbsoluteTransform: () => { point: (p: { x: number; y: number }) => { x: number; y: number } }; container: () => HTMLElement };
      const st = (window as unknown as { Konva: { stages: St[] } }).Konva.stages[0]!;
      const p = st.getAbsoluteTransform().point({ x: sx! * 8, y: sy! * 8 });
      const box = st.container().getBoundingClientRect();
      return { x: box.left + p.x, y: box.top + p.y };
    }, [at.x, y]);
  const a = await on(at.y);
  const b = await on(at.y + dy);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

async function openPanel(page: Page, id: string) {
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.keyboard.press('f');
  await mapMenu(page, 'Modules & sets', 'Live Ops');
  await expect(page.getByTestId('ops-panel')).toBeVisible();
}
async function newJob(page: Page, name: string, stops: string[]) {
  const panel = page.getByTestId('ops-panel');
  await panel.getByTestId('ops-tab-jobs').click();
  await panel.getByTestId('ops-new-job').click();
  await panel.getByTestId('ops-job-name').fill(name);
  await panel.getByTestId('ops-job-name').press('Enter');
  for (const s of stops) {
    await panel.getByTestId('ops-add-stop').selectOption({ label: s });
    await expect(panel.getByTestId('ops-stops')).toContainText(s);
  }
}
/** Leave the field, so Ctrl+Z is the map's. */
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

test('make waybills and jobs, work the switch list, and delete a place they name', async ({ page, browser }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `ops-${Date.now()}@example.com`, 'Yardmaster');
  const id = await newLayout(page, 'Operations');
  await openPanel(page, id);
  const panel = page.getByTestId('ops-panel');
  await expect(panel.locator('[data-car="c1"]').getByTestId('ops-car-at')).toHaveText('At Acme Cannery, Dock');

  await panel.getByTestId('ops-tab-waybills').click();
  await expect(panel).toContainText('No waybills yet.');
  await panel.getByTestId('ops-make').click();
  await expect(panel.getByRole('list', { name: 'Waybills to make' })).toContainText('101: Loaded to Mill');
  await panel.getByTestId('ops-make-add').click();
  await expect(panel.getByTestId('ops-cant')).toContainText('101: No job goes from Acme Cannery to Mill.');
  await expect(panel.getByTestId('ops-cant')).toContainText('102: No job goes from Mill to Acme Cannery.');

  await newJob(page, 'Mill Turn', ['Acme Cannery', 'Mill']);
  await expect(panel.getByTestId('ops-switch-list')).toContainText('Pick up 101 for Mill');
  await expect(panel.getByTestId('ops-switch-list')).toContainText('Set out 101 at Dock');
  await panel.getByTestId('ops-back').click();
  await newJob(page, 'Cannery Turn', ['Mill', 'Acme Cannery']);
  await expect(panel.getByTestId('ops-switch-list')).toContainText('Pick up 102 for Acme Cannery');
  await expect(panel.getByTestId('ops-cant')).toHaveCount(0);
  await panel.getByTestId('ops-back').click();
  await expect(panel.locator('[data-job]').first()).toContainText('Mill Turn');
  await expect(panel.getByTestId('ops-job-moves')).toHaveText([/2 stops · 2 moves/, /2 stops · 2 moves/]);

  // Someone else, with a switch list open.
  const other = await browser.newContext();
  const theirs = await other.newPage();
  await theirs.setViewportSize({ width: 1400, height: 900 });
  await other.addCookies(await page.context().cookies());
  await openPanel(theirs, id);
  await theirs.getByTestId('ops-tab-jobs').click();
  await theirs.getByRole('button', { name: 'Mill Turn', exact: true }).click();
  await expect(theirs.getByTestId('ops-switch-list')).toContainText('Pick up 101');

  // 101 is dragged to the mill: it is there, on both, and the list is done.
  await dragCar(page, 'c1', 20);
  await panel.getByTestId('ops-tab-cars').click();
  const mine = panel.locator('[data-car="c1"]');
  await expect(mine.getByTestId('ops-car-at')).toHaveText('At Mill, Dock');
  await expect(mine.getByTestId('ops-car-next')).toContainText('it’s there');
  await expect(theirs.getByTestId('ops-switch-list')).toContainText('Nothing to do', { timeout: 10000 });
  await mine.getByTestId('ops-delivered').click();
  await expect(mine.getByTestId('ops-car-next')).toHaveText('Nowhere to go: it stays.');
  await theirs.getByTestId('ops-tab-waybills').click();
  await expect(theirs.locator('[data-waybill]').filter({ hasText: '101' })).toContainText('Finished', { timeout: 10000 });

  // Undo takes the delivery back.
  await blur(page);
  await page.keyboard.press('Control+z');
  await expect(mine.getByTestId('ops-car-next')).toContainText('Loaded to Mill');

  // The car's bar says where it goes and opens its waybill.
  const at = (await cars(page)).c1!;
  await dragCar(page, 'c1', 0);
  expect(at).toBeTruthy();
  await expect(page.getByTestId('car-ops')).toHaveText('Loaded to Mill');
  await page.getByTestId('car-ops').click();
  await expect(panel.getByTestId('ops-waybill')).toBeVisible();
  await page.getByTestId('car-bar').getByRole('button', { name: 'Close' }).click();

  // The cannery goes: the dialog says what names it; 102 is listed with why, and Undo brings it all back.
  await mapMenu(page, 'Modules & sets', 'Places');
  await page.getByTestId('places-panel').getByRole('button', { name: 'Acme Cannery', exact: true }).click();
  await page.getByTestId('place-delete').click();
  const ask = page.getByRole('alertdialog').or(page.getByRole('dialog'));
  await expect(ask).toContainText('In use by 2 waybills, 2 jobs');
  await ask.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(panel.getByTestId('ops-cant')).toContainText('102: The place it goes to was deleted.');
  await blur(page);
  await page.keyboard.press('Control+z');
  await expect(panel.getByTestId('ops-cant')).toHaveCount(0);

  // All there after a reload.
  await page.reload();
  await expect(page.getByTestId('ops-panel')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('ops-tab-jobs').click();
  await expect(page.locator('[data-job]')).toHaveCount(2);
  await other.close();
});

test('on a phone: the Live Ops sheet, a job’s switch list and Delivered', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await signIn(page, `ops-phone-${Date.now()}@example.com`, 'Phone Crew');
  const id = await newLayout(page, 'Ops by phone');
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
  await page.getByRole('button', { name: /Ops by phone/ }).first().tap();
  await page.getByTestId('phone-liveops').tap();
  const panel = page.getByTestId('ops-panel');
  await panel.getByTestId('ops-tab-waybills').tap();
  await panel.getByTestId('ops-make').tap();
  await panel.getByTestId('ops-make-add').tap();
  await panel.getByTestId('ops-tab-jobs').tap();
  await panel.getByTestId('ops-new-job').tap();
  for (const s of ['Acme Cannery', 'Mill']) await panel.getByTestId('ops-add-stop').selectOption({ label: s });
  await expect(panel.getByTestId('ops-switch-list')).toContainText('Pick up 101 for Mill');
  await panel.getByTestId('ops-tab-waybills').tap();
  await panel.getByRole('button', { name: '101' }).tap();
  await panel.getByTestId('ops-delivered').tap();
  await expect(panel.getByTestId('ops-restart')).toBeVisible();
  // Nothing wider than the screen.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await ctx.close();
});
