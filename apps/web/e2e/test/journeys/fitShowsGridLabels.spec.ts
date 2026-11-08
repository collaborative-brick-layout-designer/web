// Opening a layout, and Fit, keep the grid's column letters (A, B, C…) and
// row numbers (1, 2, 3…) on screen at a desktop window size. Before, the
// desktop-size fit took in the parts only, and the letters above them were
// cut off at the top of the map (only a phone's fit took them in).

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn } from '../../helpers';

const BBM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures/tight-corner.bbm'), 'utf-8');

interface Box { x1: number; y1: number; x2: number; y2: number }

/** The stage's size and the grid labels it draws, in stage pixels. */
function gridLabels(page: Page): Promise<{ width: number; height: number; labels: (Box & { text: string })[] }> {
  return page.evaluate(() => {
    type N = { getClientRect: () => { x: number; y: number; width: number; height: number }; isVisible: () => boolean; text?: () => string; getParent: () => { name: () => string } | null };
    const st = (window as unknown as { Konva?: { stages: { width: () => number; height: () => number; find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    if (!st) return { width: 0, height: 0, labels: [] };
    const labels = st
      .find((n) => n.getParent()?.name() === 'cell-index' && n.isVisible())
      .map((n) => {
        const r = n.getClientRect();
        return { text: n.text!(), x1: r.x, y1: r.y, x2: r.x + r.width, y2: r.y + r.height };
      });
    return { width: st.width(), height: st.height(), labels };
  });
}

async function expectLabelsOnScreen(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const s = await gridLabels(page);
      const inside = (l: Box) => l.x1 >= 0 && l.y1 >= 0 && l.x2 <= s.width && l.y2 <= s.height;
      return ['A', 'B', 'C', '1', '2'].map((t) => {
        const l = s.labels.find((x) => x.text === t);
        return `${t}:${l ? (inside(l) ? 'on' : 'cut') : 'none'}`;
      });
    }, { timeout: 15000 })
    .toEqual(['A:on', 'B:on', 'C:on', '1:on', '2:on']);
}

test.use({ viewport: { width: 1440, height: 900 } });

test('opening a layout and Fit keep the grid letters and numbers on screen', async ({ page }) => {
  await signIn(page, `fit-labels-${Date.now()}@example.com`, 'Fit Labels');
  const res = await page.request.post('/api/layouts', { data: { title: 'Town corner', bbm: BBM } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });

  // The view it opens with.
  await expectLabelsOnScreen(page);

  // Zoom in and away, then Fit brings them back.
  const canvas = (await page.getByTestId('canvas-area').boundingBox())!;
  await page.mouse.move(canvas.x + canvas.width * 0.7, canvas.y + canvas.height * 0.7);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await gridLabels(page)).labels.some((l) => l.text === 'A' && l.y1 >= 0 && l.x1 >= 0)).toBe(false);
  await page.getByRole('button', { name: 'Fit', exact: true }).first().click();
  await expectLabelsOnScreen(page);
});
