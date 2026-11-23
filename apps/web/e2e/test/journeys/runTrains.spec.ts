// Running trains (trains design Phase 5), on the 96-stud stub of 9V track in
// tight-corner.bbm. A train with a route drawn from its front runs it on
// Play and stops at the route's end, with nothing written to the layout;
// Stop puts it back where it stands. Two trains facing each other both stop
// before they touch, with a red ring on the map and a plain sentence with
// Show me.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { signIn } from '../../helpers';

const BBM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures/tight-corner.bbm'), 'utf-8');

/** A stub of 9V track in tight-corner.bbm: 96 studs from (456, 144) down to (456, 240), open at both ends. */
const STUB = { x: 456, top: 144, length: 96 };

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

/** How many map nodes have this name. */
function count(page: Page, name: string): Promise<number> {
  return page.evaluate((n) => {
    type N = { name: () => string; find: (f: (n: N) => boolean) => N[] };
    const st = (window as unknown as { Konva: { stages: N[] } }).Konva.stages[0]!;
    return st.find((x) => x.name() === n).length;
  }, name);
}

/** The middle (studs) of each car drawn in `group` ('run-trains': running; 'trains': standing). */
function cars(page: Page, group: string): Promise<{ x: number; y: number }[]> {
  return page.evaluate((g) => {
    type N = { name: () => string; x: () => number; y: () => number; find: (f: (n: N) => boolean) => N[] };
    const st = (window as unknown as { Konva: { stages: N[] } }).Konva.stages[0]!;
    const groups = st.find((x) => x.name() === g);
    return groups.flatMap((grp) => grp.find((x) => x.name() === 'train-unit').map((u) => ({ x: u.x() / 8, y: u.y() / 8 })));
  }, group);
}

async function openLayout(page: Page, who: string) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `${who}-${Date.now()}@example.com`, 'Train Driver');
  const { id } = (await (await page.request.post('/api/layouts', { data: { title: `Run ${who}`, bbm: BBM } })).json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.keyboard.press('f');
  return id;
}

async function showPanel(page: Page, name: string) {
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByRole('checkbox', { name, exact: true }).check();
  await page.keyboard.press('Escape');
}

async function newCar(page: Page, number: string) {
  await page.getByTestId('trains-tab-stock').click();
  await page.getByTestId('stock-new').click();
  const ed = page.getByTestId('stock-editor');
  await ed.getByLabel('Road number').fill(number);
  await ed.getByTestId('stock-length').fill('40');
  await ed.getByTestId('stock-save').click();
  await expect(page.getByRole('list', { name: 'Rolling stock' })).toContainText(number);
}

/** A one-car train of `number`, its front put at `y` on the stub. */
async function trainAt(page: Page, number: string, name: string, y: number) {
  await newCar(page, number);
  await page.getByLabel(`Pick ${number} for a new train`).check();
  await page.getByTestId('train-from-ticked').click();
  await page.getByTestId('trains-tab-trains').click();
  const row = page.getByRole('list', { name: 'Trains' }).getByRole('listitem').filter({ hasText: /Train \d/ }).last();
  await row.getByRole('button', { name: 'Change', exact: true }).click();
  await page.getByTestId('train-editor').getByLabel('Train name').fill(name);
  await page.getByTestId('train-editor').getByTestId('train-save').click();
  const mine = page.getByRole('list', { name: 'Trains' }).getByRole('listitem').filter({ hasText: name });
  await mine.getByTestId('train-place').click();
  const p = await onPage(page, STUB.x, y);
  await page.mouse.click(p.x, p.y);
  await expect(mine.getByTestId('train-state')).toHaveText('On the track');
  return mine;
}

async function serverTrains(page: Page, id: string): Promise<{ name: string; position: unknown }[]> {
  const res = await page.request.get(`/api/layouts/${id}/export.bbm.bld`);
  if (!res.ok()) return [];
  return ((await res.json()) as { trains?: { name: string; position: unknown }[] }).trains ?? [];
}

test('Play runs a train along its route; it stops at the end, and the layout is left as it was', async ({ page }) => {
  test.setTimeout(150_000);
  const id = await openLayout(page, 'run-route');
  await showPanel(page, 'Trains');
  // Its front in the middle of the stub: the car lies below it, facing up.
  await trainAt(page, '601', 'Daylight', STUB.top + 44);
  const standing = await cars(page, 'trains');
  expect(standing).toHaveLength(1);

  // A route from its front to near the top end.
  await showPanel(page, 'Routes');
  await page.getByTestId('route-new').click();
  const banner = page.getByTestId('route-draft-banner');
  let p = await onPage(page, STUB.x, STUB.top + 44);
  await page.mouse.click(p.x, p.y);
  p = await onPage(page, STUB.x, STUB.top + 10);
  await page.mouse.click(p.x, p.y);
  await banner.getByLabel('Route name').fill('Up the stub');
  await banner.getByRole('button', { name: 'Save route' }).click();
  await expect(banner).toHaveCount(0);
  await expect.poll(async () => (await serverTrains(page, id)).length).toBe(1);
  const before = JSON.stringify(await serverTrains(page, id));

  // Run: the corner panel, the train on its own route.
  await page.getByTestId('run-mode').click();
  const panel = page.getByTestId('run-panel');
  await expect(panel).toBeVisible();
  const row = panel.getByTestId('run-train').filter({ hasText: 'Daylight' });
  await expect(row.getByTestId('run-route')).toHaveValue(/.+/);
  await expect(row.getByTestId('run-route').locator('option:checked')).toHaveText('Route: Up the stub');
  await expect(row.getByTestId('run-speed')).toHaveText('25 mph');
  await panel.getByTestId('run-play').click();
  // It moves up the stub, then stops at the route's end.
  await expect(row.getByTestId('run-state')).toHaveAttribute('data-state', 'arrived', { timeout: 15000 });
  await expect(panel.getByTestId('run-note').filter({ hasText: 'reached the end of Up the stub' })).toBeVisible();
  await expect(panel.getByTestId('run-play')).toHaveText(/Play/);
  const ran = await cars(page, 'run-trains');
  expect(ran).toHaveLength(1);
  expect(ran[0]!.y).toBeLessThan(standing[0]!.y - 25);
  expect(Math.abs(ran[0]!.x - standing[0]!.x)).toBeLessThan(1);
  // The standing copy isn't drawn while it runs.
  expect(await cars(page, 'trains')).toHaveLength(0);

  // Nothing about the run went into the layout.
  await page.waitForTimeout(1500);
  expect(JSON.stringify(await serverTrains(page, id))).toBe(before);

  // Restart puts it back at the start; Stop leaves Run mode, and the train stands where it was.
  await panel.getByTestId('run-restart').click();
  await expect.poll(() => count(page, 'run-trains')).toBe(0);
  await page.getByTestId('run-mode').click();
  await expect(panel).toHaveCount(0);
  const again = await cars(page, 'trains');
  expect(again).toHaveLength(1);
  expect(again[0]!.y).toBeCloseTo(standing[0]!.y, 3);
});

test('two trains heading for each other both stop before they touch, with a marker and Show me', async ({ page }) => {
  test.setTimeout(150_000);
  await openLayout(page, 'run-collide');
  await showPanel(page, 'Trains');
  // A: its front near the top, the car below; turned around, it faces down the stub.
  const a = await trainAt(page, '701', 'Down train', STUB.top + 12);
  await a.getByTestId('train-turn').click();
  // B: its front near the bottom, the car above, facing down; turned around it faces up, towards A.
  const b = await trainAt(page, '702', 'Up train', STUB.top + 84);
  await b.getByTestId('train-turn').click();
  await expect.poll(async () => (await cars(page, 'trains')).length).toBe(2);

  await page.getByTestId('run-mode').click();
  const panel = page.getByTestId('run-panel');
  // Neither has a route: each runs from where it stands, following the switches.
  for (const name of ['Down train', 'Up train']) {
    await expect(panel.getByTestId('run-train').filter({ hasText: name }).getByTestId('run-route').locator('option:checked')).toHaveText(/From where it stands/);
  }
  await panel.getByTestId('run-play').click();
  for (const name of ['Down train', 'Up train']) {
    await expect(panel.getByTestId('run-train').filter({ hasText: name }).getByTestId('run-state')).toHaveAttribute('data-state', 'blocked', { timeout: 15000 });
  }
  const note = panel.getByTestId('run-note').filter({ hasText: 'would collide here, so both stopped' });
  await expect(note).toHaveCount(1);
  await expect(note).toContainText('Down train');
  await expect(note).toContainText('Up train');
  await expect.poll(() => count(page, 'collision-mark')).toBe(1);
  await note.getByRole('button', { name: 'Show me' }).click();
  await expect.poll(() => count(page, 'fit-spotlight')).toBe(1);
  // Play again: they still meet, so they stay stopped.
  await panel.getByTestId('run-play').click();
  await expect(panel.getByTestId('run-play')).toHaveText(/Play/);
  await expect.poll(() => count(page, 'collision-mark')).toBe(1);
  // Taking one out of the run: it stands on the track, and the other still stops short of it.
  await panel.getByRole('checkbox', { name: 'Run Up train' }).uncheck();
  await panel.getByTestId('run-play').click();
  await expect(panel.getByTestId('run-train').filter({ hasText: 'Down train' }).getByTestId('run-state')).toHaveAttribute('data-state', 'blocked', { timeout: 15000 });
  await expect(panel.getByTestId('run-note').filter({ hasText: 'Down train and Up train would collide' })).toHaveCount(1);
});
