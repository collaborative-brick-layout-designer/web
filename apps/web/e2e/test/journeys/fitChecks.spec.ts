// Fit checks (trains design Phase 4): a two-car train put at the top of a
// 96-stud stub of 9V track fits ("Every train on the track fits"); adding a
// third car makes it longer than the stub, and the Checks list says so at
// once, with a ring on the map and Show me; taking the car out again
// clears it. View › Siding lengths labels the track's runs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { mapMenu, signIn } from '../../helpers';

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

async function newCar(page: Page, number: string) {
  await page.getByTestId('stock-new').click();
  const ed = page.getByTestId('stock-editor');
  await ed.getByLabel('Road number').fill(number);
  await ed.getByTestId('stock-length').fill('40');
  await ed.getByTestId('stock-save').click();
  await expect(page.getByRole('list', { name: 'Rolling stock' })).toContainText(number);
}

test('a train too long for its siding is flagged, and shortening it clears that at once', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `fit-${Date.now()}@example.com`, 'Fit Checker');
  const { id } = (await (await page.request.post('/api/layouts', { data: { title: 'Fit checks', bbm: BBM } })).json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.keyboard.press('f');
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Trains', exact: true }).check();
  await page.keyboard.press('Escape');

  for (const n of ['501', '502', '503']) await newCar(page, n);
  for (const n of ['501', '502']) await page.getByLabel(`Pick ${n} for a new train`).check();
  await page.getByTestId('train-from-ticked').click();
  const row = page.getByRole('list', { name: 'Trains' }).getByRole('listitem').filter({ hasText: 'Train 1' });

  // Put its front near the top of the stub: 80 studs of train in 96 of track.
  await row.getByTestId('train-place').click();
  const p = await onPage(page, STUB.x, STUB.top + 4);
  await page.mouse.click(p.x, p.y);
  await expect(row.getByTestId('train-state')).toHaveText('On the track');
  const checks = page.getByTestId('fit-checks');
  await expect(checks.getByTestId('fit-checks-clear')).toContainText('Every train on the track fits');
  expect(await count(page, 'fit-check-mark')).toBe(0);

  // A third car: 120 studs is longer than the stub. Said at once, ringed on the map.
  await row.getByRole('button', { name: 'Change', exact: true }).click();
  const editor = page.getByTestId('train-editor');
  await editor.getByLabel('Car to add').selectOption({ label: '503' });
  await editor.getByTestId('train-add-unit').click();
  await editor.getByTestId('train-save').click();
  const siding = checks.locator('[data-check="siding"]');
  await expect(siding).toContainText('Train 1');
  await expect(siding).toContainText('is longer than the track it stands in');
  await expect.poll(() => count(page, 'fit-check-mark')).toBeGreaterThan(0);
  // Show me brings the spot into view and rings it.
  await siding.getByRole('button', { name: 'Show me' }).click();
  await expect.poll(() => count(page, 'fit-spotlight')).toBe(1);

  // Shorter again: the warning goes, with nothing to refresh.
  await row.getByRole('button', { name: 'Change', exact: true }).click();
  await page.getByTestId('train-editor').getByRole('button', { name: 'Take car 3 out' }).click();
  await page.getByTestId('train-editor').getByTestId('train-save').click();
  await expect(checks.locator('[data-check="siding"]')).toHaveCount(0);
  await expect(checks.getByTestId('fit-checks-clear')).toBeVisible();

  // View › Siding lengths labels the runs of track.
  expect(await count(page, 'siding-length')).toBe(0);
  await mapMenu(page, 'View', 'Siding lengths');
  await expect.poll(() => count(page, 'siding-length')).toBeGreaterThan(5);
  await mapMenu(page, 'View', 'Siding lengths');
  await expect.poll(() => count(page, 'siding-length')).toBe(0);
});
