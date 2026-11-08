// Journey — moving a placed set.
//
//   Place a set from the library → press on one of its parts (not picked
//   yet) and drag: the whole set moves, none of it left behind → drag it
//   again by another of its parts → nudge it with an arrow key → turn it
//   with R → undo and redo → duplicate it and move the copy → a second
//   window on the same layout sees every part of the set where it is.

import { test, expect, type Page } from '@playwright/test';
import { signIn } from '../../helpers';

const ts = Date.now();

interface Placed {
  id: string;
  x: number;
  y: number;
  rot: number;
}

/** Every placed part's Konva node: id, centre (stage px) and turn. */
function placed(page: Page): Promise<Placed[]> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string; x: () => number; y: () => number; rotation: () => number };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    if (!st) return [];
    return st
      .find((n) => n.getClassName() === 'Group' && /^brick-/.test(n.name().split(' ')[0] ?? ''))
      .map((n) => ({ id: n.name().split(' ')[0]!.slice('brick-'.length), x: n.x(), y: n.y(), rot: n.rotation() }));
  });
}

/** Where a part is on the screen. */
async function onScreen(page: Page, id: string): Promise<{ x: number; y: number }> {
  const p = await page.evaluate((id) => {
    type N = { getAbsolutePosition: () => { x: number; y: number } };
    const st = (window as unknown as { Konva: { stages: { container: () => HTMLElement; findOne: (s: string) => N | undefined }[] } }).Konva.stages[0]!;
    const box = st.container().getBoundingClientRect();
    const a = st.findOne(`.brick-${id}`)!.getAbsolutePosition();
    return { x: box.left + a.x, y: box.top + a.y };
  }, id);
  return p;
}

async function drag(page: Page, from: { x: number; y: number }, by: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(from.x + (by.x * i) / 8, from.y + (by.y * i) / 8);
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(200);
  await page.mouse.up();
}

/** Each part's move from `a` to `b`, by id. */
function moves(a: Placed[], b: Placed[]): { id: string; dx: number; dy: number; dr: number }[] {
  const was = new Map(a.map((p) => [p.id, p]));
  return b.filter((p) => was.has(p.id)).map((p) => ({ id: p.id, dx: p.x - was.get(p.id)!.x, dy: p.y - was.get(p.id)!.y, dr: p.rot - was.get(p.id)!.rot }));
}

/** The distances between every two parts, smallest first: the same while the set stays whole. */
function shape(ps: Placed[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) out.push(Math.hypot(ps[i]!.x - ps[j]!.x, ps[i]!.y - ps[j]!.y));
  return out.sort((a, b) => a - b);
}

function expectSameShape(a: Placed[], b: Placed[]) {
  const sa = shape(a);
  const sb = shape(b);
  expect(sb.length).toBe(sa.length);
  sa.forEach((d, i) => expect(sb[i]!).toBeCloseTo(d, 1));
}

async function deselect(page: Page) {
  await page.keyboard.press('Escape');
  const stage = page.locator('.konvajs-content').first();
  await stage.click({ position: { x: 8, y: 8 } });
  await expect(page.locator('footer')).not.toContainText('selected:');
}

test('a placed set moves whole: dragged by any of its parts, nudged, turned, undone, duplicated, and seen live', async ({ page, browser }) => {
  test.setTimeout(240_000);
  await signIn(page, `j-setmove-${ts}@example.com`, 'Set Mover');
  const res = await page.request.post('/api/layouts', { data: { title: 'Set moves' } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });

  // ── Place a set of four parts from the library. ──
  await page.getByPlaceholder('Search parts (name or number)').fill('Single_Crossover_Left');
  const tile = page.locator('aside li button[draggable="true"]').filter({ hasText: /Single Crossover Left/ }).first();
  await expect(tile).toBeVisible({ timeout: 15000 });
  await tile.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('footer')).toContainText('(4 parts)');
  await expect.poll(async () => (await placed(page)).length).toBe(4);
  const start = await placed(page);
  await page.waitForTimeout(600); // links settle

  // ── Press on a part that isn't picked and drag: the whole set moves. ──
  await deselect(page);
  await drag(page, await onScreen(page, start[0]!.id), { x: 160, y: 96 });
  await expect(page.locator('footer')).toContainText('selected: 4');
  const afterFirst = await placed(page);
  const m1 = moves(start, afterFirst);
  expect(Math.hypot(m1[0]!.dx, m1[0]!.dy)).toBeGreaterThan(40);
  for (const m of m1) {
    expect(m.dx).toBeCloseTo(m1[0]!.dx, 1);
    expect(m.dy).toBeCloseTo(m1[0]!.dy, 1);
  }
  expectSameShape(start, afterFirst);

  // ── Again, by another of its parts. ──
  await deselect(page);
  await drag(page, await onScreen(page, start[2]!.id), { x: -120, y: 80 });
  const afterSecond = await placed(page);
  const m2 = moves(afterFirst, afterSecond);
  expect(Math.hypot(m2[0]!.dx, m2[0]!.dy)).toBeGreaterThan(40);
  for (const m of m2) {
    expect(m.dx).toBeCloseTo(m2[0]!.dx, 1);
    expect(m.dy).toBeCloseTo(m2[0]!.dy, 1);
  }

  // ── Picked with a click, nudged with an arrow key (its own undo step). ──
  await page.waitForTimeout(400);
  await deselect(page);
  const at = await onScreen(page, start[1]!.id);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('footer')).toContainText('selected: 4');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => moves(afterSecond, await placed(page)).every((m) => m.dx > 0)).toBe(true);
  const nudged = await placed(page);
  for (const m of moves(afterSecond, nudged)) {
    expect(m.dx).toBeCloseTo(moves(afterSecond, nudged)[0]!.dx, 1);
    expect(m.dy).toBeCloseTo(0, 1);
  }

  // ── Turned with R: still the same shape. ──
  await page.waitForTimeout(400); // its own undo step
  await page.keyboard.press('r');
  await expect.poll(async () => moves(nudged, await placed(page)).some((m) => Math.abs(m.dr) > 1)).toBe(true);
  const turned = await placed(page);
  expectSameShape(nudged, turned);

  // ── Undo the turn and the nudge, redo them. ──
  await page.keyboard.press('Control+z');
  await expect.poll(async () => moves(nudged, await placed(page)).every((m) => Math.abs(m.dx) < 0.01 && Math.abs(m.dr) < 0.01)).toBe(true);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => moves(afterSecond, await placed(page)).every((m) => Math.abs(m.dx) < 0.01)).toBe(true);
  await page.keyboard.press('Control+y');
  await expect.poll(async () => moves(nudged, await placed(page)).every((m) => Math.abs(m.dx) < 0.01)).toBe(true);
  await page.keyboard.press('Control+y');
  await expect.poll(async () => moves(turned, await placed(page)).every((m) => Math.abs(m.dx) < 0.01 && Math.abs(m.dy) < 0.01)).toBe(true);

  // ── Duplicate it, then move the copy by one of its parts. ──
  await page.mouse.move(600, 300);
  await page.keyboard.press('Control+d');
  await expect.poll(async () => (await placed(page)).length).toBe(8);
  await expect(page.locator('footer')).toContainText('selected: 4');
  const withCopy = await placed(page);
  const originals = new Set(start.map((p) => p.id));
  const copy = withCopy.filter((p) => !originals.has(p.id));
  expectSameShape(turned, copy);
  await page.waitForTimeout(600);
  await deselect(page);
  await drag(page, await onScreen(page, copy[3]!.id), { x: 100, y: -60 });
  const afterCopyMove = await placed(page);
  const mc = moves(withCopy, afterCopyMove);
  for (const m of mc) {
    if (originals.has(m.id)) {
      expect(Math.abs(m.dx) + Math.abs(m.dy)).toBeLessThan(0.01);
    } else {
      expect(Math.hypot(m.dx, m.dy)).toBeGreaterThan(40);
      expect(m.dx).toBeCloseTo(mc.find((n) => !originals.has(n.id))!.dx, 1);
    }
  }

  // ── Another window on the layout sees every part where it is. ──
  const peer = await browser.newPage({ storageState: await page.context().storageState() });
  await peer.goto(`/editor/${id}`);
  await expect(peer.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => (await placed(peer)).length, { timeout: 15000 }).toBe(8);
  const there = new Map((await placed(peer)).map((p) => [p.id, p]));
  for (const p of afterCopyMove) {
    expect(there.get(p.id)!.x).toBeCloseTo(p.x, 1);
    expect(there.get(p.id)!.y).toBeCloseTo(p.y, 1);
  }
  // …and the next drag live.
  await deselect(page);
  await drag(page, await onScreen(page, start[3]!.id), { x: 0, y: 120 });
  const mine = await placed(page);
  await expect
    .poll(async () => {
      const t = new Map((await placed(peer)).map((p) => [p.id, p]));
      return mine.every((p) => Math.abs(t.get(p.id)!.x - p.x) < 0.1 && Math.abs(t.get(p.id)!.y - p.y) < 0.1);
    }, { timeout: 15000 })
    .toBe(true);
  await peer.close();
});

test('turning a set with R in the middle of a drag turns every part of it, and it goes on following the mouse', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, `j-setmove-${ts}@example.com`, 'Set Mover');
  const res = await page.request.post('/api/layouts', { data: { title: 'Set turned mid-drag' } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await page.getByPlaceholder('Search parts (name or number)').fill('Single_Crossover_Left');
  const tile = page.locator('aside li button[draggable="true"]').filter({ hasText: /Single Crossover Left/ }).first();
  await expect(tile).toBeVisible({ timeout: 15000 });
  await tile.focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await placed(page)).length).toBe(4);
  await page.waitForTimeout(600);
  const start = await placed(page);
  await deselect(page);

  // Press, move, R, move on, let go.
  const from = await onScreen(page, start[0]!.id);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(from.x + i * 20, from.y + i * 10);
    await page.waitForTimeout(25);
  }
  await page.keyboard.press('r');
  await page.waitForTimeout(300);
  const turnedMidDrag = await placed(page);
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(from.x + 80 + i * 20, from.y + 40 + i * 10);
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(600);
  const dropped = await placed(page);

  // Every part turned the same way (the set's other parts too), the set kept its shape…
  const turns = moves(start, dropped).map((m) => ((Math.round(m.dr) % 360) + 360) % 360);
  expect(new Set(turns)).toEqual(new Set([270]));
  expectSameShape(start, dropped);
  // …and it went on following the mouse after the turn.
  const after = moves(turnedMidDrag, dropped);
  for (const m of after) {
    expect(m.dx).toBeCloseTo(80, 0);
    expect(m.dy).toBeCloseTo(40, 0);
  }

  // What's drawn is what the layout has: opened again, every part is where it was.
  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => (await placed(page)).length, { timeout: 15000 }).toBe(4);
  const again = new Map((await placed(page)).map((p) => [p.id, p]));
  for (const p of dropped) {
    expect(again.get(p.id)!.x).toBeCloseTo(p.x, 1);
    expect(again.get(p.id)!.y).toBeCloseTo(p.y, 1);
    expect((((again.get(p.id)!.rot - p.rot) % 360) + 360) % 360).toBeCloseTo(0, 1);
  }
});
