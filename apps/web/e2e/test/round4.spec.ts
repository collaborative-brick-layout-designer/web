// E2E: the round-4 parity leftovers — Duplicate lands at the cursor, the
// View → Status Bar toggle and the ruler length readout.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn, mapMenu } from '../helpers';

const FORDYCE_BBM = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm'),
  'utf-8',
);
const EMAIL = `round4-e2e-${Date.now()}@example.com`;

async function createLayout(page: Page, bbm?: string): Promise<string> {
  await signIn(page, EMAIL, 'Round Four Tester');
  const res = await page.request.post('/api/layouts', { data: bbm ? { title: 'Round 4', bbm } : { title: 'Round 4' } });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function openEditor(page: Page, id: string): Promise<void> {
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1000);
}

/** Centres (studs) of every brick of `part` in an exported .bbm. */
function centresOf(bbm: string, part: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const m of bbm.matchAll(/<Brick id="[^"]*">\s*<DisplayArea>\s*<X>([^<]+)<\/X>\s*<Y>([^<]+)<\/Y>\s*<Width>([^<]+)<\/Width>\s*<Height>([^<]+)<\/Height>[\s\S]*?<PartNumber>([^<]*)<\/PartNumber>/g)) {
    if (m[5] !== part) continue;
    out.push({ x: Number(m[1]) + Number(m[3]) / 2, y: Number(m[2]) + Number(m[4]) / 2 });
  }
  return out;
}

/** Screen position → studs through the stage's pan and zoom. */
async function toStuds(page: Page, sx: number, sy: number): Promise<{ x: number; y: number }> {
  const t = await page.evaluate(() => {
    const st = (window as unknown as { Konva: { stages: { x: () => number; y: () => number; scaleX: () => number }[] } }).Konva.stages[0]!;
    return { x: st.x(), y: st.y(), z: st.scaleX() };
  });
  const box = (await page.locator('.konvajs-content').first().boundingBox())!;
  return { x: (sx - box.x - t.x) / (8 * t.z), y: (sy - box.y - t.y) / (8 * t.z) };
}

test.describe('Duplicate', () => {
  test('pastes the copy centred under the cursor, like desktop copy + paste', async ({ page }) => {
    test.slow();
    const id = await createLayout(page, FORDYCE_BBM);
    await openEditor(page, id);
    const bbm = () => page.request.get(`/api/layouts/${id}/export.bbm`).then((r) => r.text());
    const before = centresOf(FORDYCE_BBM, '3857.0');

    await page.keyboard.press('Control+f');
    const find = page.getByRole('dialog', { name: 'Find & Replace' });
    await find.getByLabel('Find in').selectOption('part');
    await find.getByPlaceholder('Search…').fill('3857.0');
    await find.locator('ul button').first().click();
    await find.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('footer')).toContainText('selected: 1');

    const box = (await page.locator('.konvajs-content').first().boundingBox())!;
    const at = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.7 };
    await page.mouse.move(at.x, at.y);
    const target = await toStuds(page, at.x, at.y);
    await page.keyboard.press('Control+d');

    await expect.poll(async () => centresOf(await bbm(), '3857.0').length).toBe(before.length + 1);
    const added = centresOf(await bbm(), '3857.0').filter((c) => !before.some((b) => Math.abs(b.x - c.x) < 1e-3 && Math.abs(b.y - c.y) < 1e-3));
    expect(added).toHaveLength(1);
    // Mouse events land on whole pixels: allow one pixel, in studs.
    const z = await page.evaluate(() => (window as unknown as { Konva: { stages: { scaleX: () => number }[] } }).Konva.stages[0]!.scaleX());
    const px = 1 / (8 * z);
    expect(Math.abs(added[0]!.x - target.x)).toBeLessThanOrEqual(px);
    expect(Math.abs(added[0]!.y - target.y)).toBeLessThanOrEqual(px);
    // Far from the original (the old Duplicate put the copy 1 stud off it).
    const orig = before.map((b) => Math.hypot(b.x - added[0]!.x, b.y - added[0]!.y));
    expect(Math.min(...orig)).toBeGreaterThan(2);
  });
});

test.describe('status bar', () => {
  test('Map → Show Status Bar hides and shows it', async ({ page }) => {
    const id = await createLayout(page);
    await openEditor(page, id);
    await expect(page.locator('footer')).toBeVisible();
    await mapMenu(page, 'View', 'Status bar');
    await expect(page.locator('footer')).toHaveCount(0);
    await mapMenu(page, 'View', 'Status bar');
    await expect(page.locator('footer')).toBeVisible();
  });

  test('drawing a ruler shows its length there', async ({ page }) => {
    const id = await createLayout(page);
    await openEditor(page, id);
    await page.getByRole('button', { name: 'Measure', exact: true }).click();
    const box = (await page.locator('.konvajs-content').first().boundingBox())!;
    const a = await toStuds(page, box.x + 100, box.y + 100);
    const b = await toStuds(page, box.x + 300, box.y + 100);
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 100, { steps: 8 });
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    await expect(page.locator('footer')).toContainText(/Ruler length: [\d.]+ studs {2}\([\d.]+ (mm|m)\)/);
    const shown = Number(/Ruler length: ([\d.]+) studs/.exec((await page.locator('footer').textContent()) ?? '')![1]);
    expect(Math.abs(shown - len)).toBeLessThan(1.5); // the end snaps to the grid step
    await page.mouse.up();
  });
});
