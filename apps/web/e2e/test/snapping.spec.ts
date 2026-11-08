// Calm connection snapping (editor/snapFeel.ts): a straight dragged near
// another snaps on, holds while it is moved a little away, and lets go
// once it is past the release distance (1.6x the reach).

import { test, expect, type Page } from '@playwright/test';
import { signIn } from '../helpers';

const EMAIL = `snap-e2e-${Date.now()}@example.com`;

async function createLayout(page: Page): Promise<string> {
  await signIn(page, EMAIL, 'Snap Tester');
  const res = await page.request.post('/api/layouts', { data: { title: 'Snap Test' } });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/** Konva nodes the snap feedback draws: the ring on the target and the moving connection's dot. */
function snapMarks(page: Page) {
  return page.evaluate(() => {
    type Node = { name: () => string };
    const K = (window as unknown as { Konva: { stages: { find: (s: (n: Node) => boolean) => Node[] }[] } }).Konva;
    const names = K.stages.flatMap((st) => st.find((n: Node) => n.name() === 'snap-ring' || n.name() === 'snap-moving')).map((n) => n.name());
    return { ring: names.includes('snap-ring'), dot: names.includes('snap-moving') };
  });
}

/** A slow, steady drag (well under the fast-drag speed), so snapping is live. */
async function slowMoveTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 4));
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await page.waitForTimeout(16);
  }
}

test.describe('connection snapping', () => {
  test('a straight snaps onto a nearby end, holds a little way off, and lets go past the release distance', async ({ page }) => {
    const id = await createLayout(page);
    await page.goto(`/editor/${id}`);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(1000);
    await page.getByPlaceholder('Search parts (name or number)').fill('2865.8');
    const tile = page.locator('aside li button[draggable="true"]').filter({ has: page.locator('img') }).first();
    const box = (await page.locator('.konvajs-content').first().boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const bricks = async () => ((await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text()).match(/<Brick id=/g) ?? []).length;

    // One straight moved 40 studs left, then a second at the view centre:
    // their facing ends are 24 studs apart.
    await tile.dblclick();
    await expect.poll(bricks).toBe(1);
    await page.waitForTimeout(300);
    for (let i = 0; i < 6; i++) await page.keyboard.press('Control+-');
    await page.waitForTimeout(300);
    const zoom = await page.evaluate(() => (window as unknown as { Konva: { stages: { scaleX: () => number }[] } }).Konva.stages[0]!.scaleX());
    const studPx = 8 * zoom;
    expect(40 * studPx).toBeLessThan(box.width / 2 - 20);
    // The reach the app uses at this zoom (snapFeel.snapReachStuds, Gentle).
    const reach = Math.min(4, Math.max(0.5, 14 / studPx));
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 40 * studPx, cy, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await tile.dblclick();
    await expect.poll(bricks).toBe(2);

    // Drag the new one slowly left until its free end is a quarter of the
    // reach from the other's: it snaps, with the ring and the dot.
    const gapAt = (gap: number) => ({ x: cx - (24 - gap) * studPx, y: cy });
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await slowMoveTo(page, { x: cx, y: cy }, gapAt(3 * reach));
    await expect.poll(async () => (await snapMarks(page)).ring).toBe(false);
    await slowMoveTo(page, gapAt(3 * reach), gapAt(0.25 * reach));
    await expect.poll(() => snapMarks(page)).toEqual({ ring: true, dot: true });

    // Back out past the reach but inside 1.6x: it holds on.
    await slowMoveTo(page, gapAt(0.25 * reach), gapAt(1.3 * reach));
    await page.waitForTimeout(200);
    expect((await snapMarks(page)).ring).toBe(true);

    // Past 1.6x the reach: it lets go.
    await slowMoveTo(page, gapAt(1.3 * reach), gapAt(1.6 * reach + 1));
    await expect.poll(async () => (await snapMarks(page)).ring).toBe(false);
    await page.mouse.up();
    await expect.poll(() => snapMarks(page)).toEqual({ ring: false, dot: false });
  });
});
