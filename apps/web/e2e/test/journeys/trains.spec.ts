// Rolling stock and trains (trains design Phase 3): make three quick cars,
// tick them and make a train, put it on the track with a click on a curve;
// each car's body lies on the chord between its trucks, so the head car's
// middle is inside the curve. A second browser sees it live; it stays after
// a reload; Turn around and Take off the track work, and a .bbm download
// says trains are left out. Then rosters: save a car to your roster, add it
// to another layout, and bring that copy up to date when the roster changes.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { mapMenu, signIn } from '../../helpers';

const BBM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures/tight-corner.bbm'), 'utf-8');

/**
 * The top-left monorail corner (2672.7, a 30 x 30 stud box at 110,110): the
 * track runs in along y = 112 and out along x = 112, round a centre at
 * (140, 140), radius 28. Its middle is the point on the arc at 45°.
 */
const CORNER = { cx: 140, cy: 140, r: 28 };
const MID = { x: CORNER.cx - CORNER.r * Math.SQRT1_2, y: CORNER.cy - CORNER.r * Math.SQRT1_2 };

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

/** Each drawn car of a train: its middle (studs) and its angle. */
function cars(page: Page, id: string): Promise<{ x: number; y: number; angle: number }[]> {
  return page.evaluate((tid) => {
    type N = { name: () => string; x: () => number; y: () => number; rotation: () => number; find: (f: (n: N) => boolean) => N[] };
    const st = (window as unknown as { Konva: { stages: N[] } }).Konva.stages[0]!;
    return st
      .find((n) => n.name() === `train-${tid}`)
      .flatMap((g) => g.find((n) => n.name() === 'train-unit'))
      .map((u) => ({ x: u.x() / 8, y: u.y() / 8, angle: u.rotation() }));
  }, id);
}

type Saved = { trains?: { id: string; name: string; units: { stock: string; reversed: boolean }[]; position: { brick: string; s: number; facing: string } | null }[]; rollingStock?: { id: string; number: string; length: number; libraryId?: string; libraryVersion?: number }[] };
async function saved(page: Page, id: string): Promise<Saved> {
  const r = await page.request.get(`/api/layouts/${id}/export.bbm.bld`);
  return r.ok() ? ((await r.json()) as Saved) : {};
}

async function openTrains(page: Page) {
  // Panels remember being open (a reload keeps it).
  if (await page.getByTestId('trains-panel').isVisible()) return;
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Trains', exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('trains-panel')).toBeVisible();
}

async function newCar(page: Page, number: string, length: number) {
  await page.getByTestId('stock-new').click();
  const ed = page.getByTestId('stock-editor');
  await ed.getByLabel('Road number').fill(number);
  await ed.getByTestId('stock-length').fill(String(length));
  await ed.getByTestId('stock-save').click();
  await expect(ed).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Rolling stock' })).toContainText(number);
}

async function openLayout(page: Page, title: string): Promise<string> {
  const { id } = (await (await page.request.post('/api/layouts', { data: { title, bbm: BBM } })).json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.keyboard.press('f');
  await openTrains(page);
  return id;
}

test('make quick cars, make a train, put it on a curve, share it, turn it and take it off', async ({ page, browser }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `trains-${Date.now()}@example.com`, 'Train Maker');
  const id = await openLayout(page, 'Trains');
  // No stock yet: the panel opens on Rolling stock and says what to do.
  await expect(page.getByTestId('trains-panel')).toContainText('No rolling stock yet');

  for (const n of ['101', '102', '103']) await newCar(page, n, 24);
  for (const n of ['101', '102', '103']) await page.getByLabel(`Pick ${n} for a new train`).check();
  await page.getByTestId('train-from-ticked').click();
  const row = page.getByRole('list', { name: 'Trains' }).getByRole('listitem').filter({ hasText: 'Train 1' });
  await expect(row.getByTestId('train-state')).toHaveText('Not on the map');
  await expect.poll(async () => (await saved(page, id)).trains?.[0]?.units.length).toBe(3);
  const trainId = (await saved(page, id)).trains![0]!.id;

  // Put on the track: a click in the middle of the corner.
  await row.getByTestId('train-place').click();
  await expect(page.getByTestId('train-place-banner')).toContainText('Train 1');
  const p = await onPage(page, MID.x, MID.y);
  await page.mouse.click(p.x, p.y);
  await expect(page.getByTestId('train-place-banner')).toHaveCount(0);
  await expect(row.getByTestId('train-state')).toHaveText('On the track');
  await expect.poll(async () => (await cars(page, trainId)).length).toBe(3);
  const placed = await cars(page, trainId);
  // The head car's trucks are both on the arc, so its middle is on the chord: inside the curve.
  const head = placed[0]!;
  const fromCentre = Math.hypot(head.x - CORNER.cx, head.y - CORNER.cy);
  expect(fromCentre).toBeLessThan(CORNER.r - 0.5);
  expect(fromCentre).toBeGreaterThan(CORNER.r - 6);
  // Cars run on round the corner: not all one way.
  expect(new Set(placed.map((c) => Math.round(c.angle))).size).toBeGreaterThan(1);
  await expect.poll(async () => (await saved(page, id)).trains?.[0]?.position?.brick).toBeTruthy();

  // A second browser sees it, live.
  const other = await browser.newContext();
  const theirs = await other.newPage();
  await theirs.setViewportSize({ width: 1400, height: 900 });
  await theirs.context().addCookies(await page.context().cookies());
  await theirs.goto(`/editor/${id}`);
  await expect(theirs.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => (await cars(theirs, trainId)).length, { timeout: 15000 }).toBe(3);

  // Turn around: the last car is now the front; the other browser follows.
  const before = (await saved(page, id)).trains![0]!;
  await row.getByTestId('train-turn').click();
  await expect.poll(async () => (await saved(page, id)).trains?.[0]?.units[0]?.stock).toBe(before.units[2]!.stock);
  const turned = (await saved(page, id)).trains![0]!;
  expect(turned.units.every((u) => u.reversed)).toBe(true);
  await expect.poll(async () => (await cars(theirs, trainId)).length).toBe(3);
  const after = await cars(page, trainId);
  // The cars stay where they were: the new head is the old tail.
  expect(Math.hypot(after[0]!.x - placed[2]!.x, after[0]!.y - placed[2]!.y)).toBeLessThan(1);

  // Still there after a reload.
  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => (await cars(page, trainId)).length, { timeout: 15000 }).toBe(3);
  await openTrains(page);
  await page.getByTestId('trains-tab-trains').click();

  // A .bbm download says BlueBrick leaves trains out.
  await mapMenu(page, 'Download & export', 'Download as…');
  const dialog = page.getByRole('dialog', { name: 'Download As' });
  await dialog.getByLabel('BlueBrick map (.bbm)').check();
  await expect(dialog.getByText(/trains/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Take off the track, on both maps; Undo puts it back.
  const row2 = page.getByRole('list', { name: 'Trains' }).getByRole('listitem').filter({ hasText: 'Train 1' });
  await row2.getByRole('button', { name: 'Take off the track' }).click();
  await expect(row2.getByTestId('train-state')).toHaveText('Not on the map');
  await expect.poll(async () => (await cars(theirs, trainId)).length, { timeout: 15000 }).toBe(0);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(row2.getByTestId('train-state')).toHaveText('On the track');
  await other.close();
});

test('a car saved to your roster goes into another layout and is brought up to date', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `roster-${Date.now()}@example.com`, 'Roster Keeper');
  const first = await openLayout(page, 'Roster one');
  await newCar(page, '4021', 32);
  const item = page.getByRole('list', { name: 'Rolling stock' }).getByRole('listitem').filter({ hasText: '4021' });
  await item.getByRole('button', { name: 'Save to roster' }).click();
  await page.getByTestId('save-to-roster-go').click();
  await expect(item).toContainText('From a roster');
  await expect.poll(async () => (await saved(page, first)).rollingStock?.[0]?.libraryVersion).toBe(1);
  const entry = ((await (await page.request.get('/api/rolling-stock')).json()) as { stock: { id: string; record: Record<string, unknown> }[] }).stock[0]!;

  // Another layout: add it from the roster.
  const second = await openLayout(page, 'Roster two');
  await page.getByTestId('roster-open').click();
  const picker = page.getByTestId('roster-picker');
  await picker.getByRole('listitem').filter({ hasText: '4021' }).getByRole('button', { name: 'Add' }).click();
  await expect(picker.getByRole('listitem').filter({ hasText: '4021' })).toContainText('In this layout');
  await expect.poll(async () => (await saved(page, second)).rollingStock?.[0]?.libraryId).toBe(entry.id);

  // The roster's car changes (as from the desktop, or another tab): the layout offers the update, live.
  const res = await page.request.patch(`/api/rolling-stock/${entry.id}`, { data: { record: { ...entry.record, length: 36 } } });
  expect(res.ok()).toBe(true);
  const item2 = page.getByRole('list', { name: 'Rolling stock' }).getByRole('listitem').filter({ hasText: '4021' });
  await expect(item2).toContainText('The roster has a newer version', { timeout: 15000 });
  await item2.getByRole('button', { name: 'Update from roster' }).click();
  await expect.poll(async () => (await saved(page, second)).rollingStock?.[0]).toMatchObject({ length: 36, libraryVersion: 2 });
  await expect(item2).not.toContainText('newer version');
});
