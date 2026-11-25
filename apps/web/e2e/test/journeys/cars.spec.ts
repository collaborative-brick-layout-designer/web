// Cars on the track (Live Ops Phase 2), on the 96-stud stub of 9V track in
// tight-corner.bbm. Three cars are put on the track coupled; the last one
// is dragged off, a second browser sees it at once, Undo brings it back,
// and dragging it again and back couples it. A car's load is set from the
// map; a car is taken off; deleting the track says so and Undo brings the
// cars back. Then the same with a finger, on a phone.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { signIn } from '../../helpers';

const BBM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures/tight-corner.bbm'), 'utf-8');
/** A stub of 9V track: 96 studs from (456, 144) down to (456, 240), open at both ends. */
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

type N = { name: () => string; id: () => string; x: () => number; y: () => number; find: (f: (n: N) => boolean) => N[] };
/** Where each car on the track is (studs), by its id. */
function cars(page: Page): Promise<Record<string, { x: number; y: number }>> {
  return page.evaluate(() => {
    const st = (window as unknown as { Konva?: { stages: N[] } }).Konva?.stages[0];
    if (!st) return {};
    return Object.fromEntries(st.find((n) => n.name() === 'car-hit').map((n) => [n.id(), { x: n.x() / 8, y: n.y() / 8 }]));
  });
}
function count(page: Page, name: string): Promise<number> {
  return page.evaluate((want) => (window as unknown as { Konva: { stages: N[] } }).Konva.stages[0]!.find((n) => n.name() === want).length, name);
}

type Saved = { trains?: { id: string; cut?: boolean; units: { stock: string }[]; position: object | null }[]; rollingStock?: { id: string; number: string; opsCut?: string; opsLoad?: string }[] };
async function saved(page: Page, id: string): Promise<Saved> {
  const r = await page.request.get(`/api/layouts/${id}/export.bbm.bld`);
  return r.ok() ? ((await r.json()) as Saved) : {};
}
/** The cuts saved, as their cars' numbers. */
async function cuts(page: Page, id: string): Promise<string[]> {
  const s = await saved(page, id);
  const number = new Map((s.rollingStock ?? []).map((c) => [c.id, c.number]));
  return (s.trains ?? []).filter((t) => t.cut && t.units.length).map((t) => t.units.map((u) => number.get(u.stock)).join(' ')).sort();
}

async function newCar(page: Page, number: string) {
  await page.getByTestId('stock-new').click();
  const ed = page.getByTestId('stock-editor');
  await ed.getByLabel('Road number').fill(number);
  await ed.getByTestId('stock-length').fill('20');
  await ed.getByTestId('stock-save').click();
  await expect(page.getByRole('list', { name: 'Rolling stock' })).toContainText(number);
}

async function dragCar(page: Page, car: string, dy: number) {
  const at = (await cars(page))[car]!;
  const a = await onPage(page, at.x, at.y);
  const b = await onPage(page, at.x, at.y + dy);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

test('put cars on the track, drag one off, undo, couple, load and take off', async ({ page, browser }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `cars-${Date.now()}@example.com`, 'Yard Hand');
  const { id } = (await (await page.request.post('/api/layouts', { data: { title: 'Cars', bbm: BBM } })).json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.keyboard.press('f');
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Trains', exact: true }).check();
  await page.keyboard.press('Escape');
  for (const n of ['101', '102', '103']) await newCar(page, n);
  for (const n of ['101', '102', '103']) await page.getByLabel(`Pick ${n} for a new train`).check();
  await page.getByTestId('cars-place').click();
  await expect(page.getByTestId('train-place-banner')).toContainText('101 and 2 more');
  const front = await onPage(page, STUB.x, STUB.top + 10);
  await page.mouse.click(front.x, front.y);
  await expect.poll(async () => Object.keys(await cars(page)).length).toBe(3);
  await expect.poll(() => cuts(page, id)).toEqual(['101 102 103']);
  await expect(page.getByTestId('car-standing').first()).toHaveText('On the track, coupled to 2 others');
  const byNumber = new Map((await saved(page, id)).rollingStock!.map((c) => [c.number, c.id]));
  const last = byNumber.get('103')!;
  const start = await cars(page);

  const other = await browser.newContext();
  const theirs = await other.newPage();
  await theirs.setViewportSize({ width: 1400, height: 900 });
  await theirs.context().addCookies(await page.context().cookies());
  await theirs.goto(`/editor/${id}`);
  await expect.poll(async () => Object.keys(await cars(theirs)).length, { timeout: 20000 }).toBe(3);

  // The last car, dragged away from the others: it goes alone.
  await dragCar(page, last, 14);
  await expect.poll(() => cuts(page, id)).toEqual(['101 102', '103']);
  await expect.poll(async () => Math.round((await cars(theirs))[last]!.y - start[last]!.y), { timeout: 10000 }).toBeGreaterThan(8);
  for (const n of ['101', '102']) expect(Math.abs((await cars(page))[byNumber.get(n)!]!.y - start[byNumber.get(n)!]!.y)).toBeLessThan(0.5);

  // Undo brings it back, on both.
  await page.keyboard.press('Control+z');
  await expect.poll(() => cuts(page, id)).toEqual(['101 102 103']);
  await expect.poll(async () => Math.round(Math.abs((await cars(theirs))[last]!.y - start[last]!.y)), { timeout: 10000 }).toBe(0);
  await page.keyboard.press('Control+y');
  await expect.poll(() => cuts(page, id)).toEqual(['101 102', '103']);

  // The other person drags it back: it couples.
  await dragCar(theirs, last, -20);
  await expect.poll(() => cuts(page, id), { timeout: 10000 }).toEqual(['101 102 103']);

  // A click: the car bar. Its load shows on both maps.
  const mid = (await cars(page))[byNumber.get('102')!]!;
  const p = await onPage(page, mid.x, mid.y);
  await page.mouse.click(p.x, p.y);
  const bar = page.getByTestId('car-bar');
  await expect(bar).toContainText('102');
  // (Marks show at a readable zoom.)
  await theirs.evaluate(([x, y]) => void window.dispatchEvent(new CustomEvent('cld:show-spot', { detail: { x, y } })), [STUB.x, STUB.top + 40]);
  await bar.getByTestId('car-load-loaded').click();
  await expect.poll(() => count(theirs, 'car-loaded'), { timeout: 10000 }).toBe(1);
  await bar.getByTestId('car-load-empty').click();
  await expect.poll(() => count(theirs, 'car-empty'), { timeout: 10000 }).toBe(1);
  // Taken off the track: the cars on either side stay.
  await bar.getByTestId('car-off').click();
  await expect(bar).toHaveCount(0);
  await expect.poll(() => cuts(page, id)).toEqual(['101', '103']);
  await page.keyboard.press('Control+z');
  await expect.poll(() => cuts(page, id)).toEqual(['101 102 103']);

  // Still there after a reload.
  await page.reload();
  await expect.poll(async () => Object.keys(await cars(page)).length, { timeout: 20000 }).toBe(3);

  // The track under them goes: the panel says so, nothing is lost, and Undo brings them back.
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.getByTestId('trains-tab-trains').click();
  const cut = page.getByRole('list', { name: 'Cars on the track' }).getByRole('listitem');
  await expect(cut).toContainText('Its track was moved or removed');
  await expect.poll(() => cuts(page, id)).toEqual(['101 102 103']);
  await page.keyboard.press('Control+z');
  await expect(cut).toContainText('On the track');
  await expect.poll(async () => Object.keys(await cars(page)).length).toBe(3);

  // A whole cut off the track.
  await cut.getByTestId('cut-off').click();
  await expect.poll(() => cuts(page, id)).toEqual([]);
  await expect(page.getByRole('list', { name: 'Cars on the track' })).toHaveCount(0);
  await other.close();
});

test('on a phone: put a car on the track, tap it, and drag it with a finger', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await signIn(page, `cars-phone-${Date.now()}@example.com`, 'Phone Crew');
  const { id } = (await (await page.request.post('/api/layouts', { data: { title: 'Cars by phone', bbm: BBM } })).json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
  const sheet = async () => {
    await page.getByRole('button', { name: /Cars by phone/ }).first().tap();
    await page.getByTestId('phone-trains').tap();
  };
  await sheet();
  await newCar(page, '7');
  // The sheet closes so the map shows.
  await page.getByTestId('car-place').tap();
  await expect(page.getByTestId('train-place-banner')).toContainText('7');
  const zoomTo = () =>
    page.evaluate(([x, y]) => {
      window.dispatchEvent(new CustomEvent('cld:show-spot', { detail: { x, y } }));
    }, [STUB.x, STUB.top + 48]);
  await zoomTo();
  await page.waitForTimeout(400);
  const spot = await onPage(page, STUB.x, STUB.top + 30);
  await page.touchscreen.tap(spot.x, spot.y);
  await expect.poll(() => cuts(page, id), { timeout: 10000 }).toEqual(['7']);
  const car = (await saved(page, id)).rollingStock![0]!.id;
  await page.waitForTimeout(400);
  const was = (await cars(page))[car]!;
  const a = await onPage(page, was.x, was.y);
  const b = await onPage(page, was.x, was.y + 16);
  const cdp = await ctx.newCDPSession(page);
  const swipe = async () => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  // Tapped, then dragged: it goes along the track, and the map stays.
  await page.touchscreen.tap(a.x, a.y);
  await expect(page.getByTestId('car-bar')).toContainText('7');
  await swipe();
  await expect.poll(async () => Math.round((await cars(page))[car]!.y - was.y)).toBeGreaterThan(10);
  expect((await cars(page))[car]!.x).toBeCloseTo(was.x, 0);
  // Its load, with a thumb.
  await page.getByTestId('car-load-loaded').tap();
  await expect.poll(async () => (await saved(page, id)).rollingStock![0]!.opsLoad).toBe('loaded');
  await ctx.close();
});
