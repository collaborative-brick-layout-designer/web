// An engine from a model (trains design Phase 6): Rolling stock › Import a
// model… with a Studio file of an engine (two bogie plates, four wheel
// holders and a magnet at each end, its parts in the file itself). The
// browser reads it, turns it to run front to the right, and puts the trucks
// on the bogies and the couplers on the magnets, and says so. A truck is
// dragged a stud, the engine turned around, and Add to rolling stock makes
// the custom part and the engine, which goes on the roster too. Made into a
// train and put on the track, it's drawn with the model's picture; a second
// browser sees it, and a reload keeps it. The desktop's
// tests/ui/StockImportUiTest.cpp walks the same; desktopLiveSync.spec.ts
// checks the desktop draws it.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn } from '../../helpers';
import { watch4xx } from '../../quietNetwork';
import { engineIo } from '../../stockModel';

const BBM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures/tight-corner.bbm'), 'utf-8');
const MID = { x: 140 - 28 * Math.SQRT1_2, y: 140 - 28 * Math.SQRT1_2 };

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

/** How many of a train's cars are drawn with a picture (a part's or a model's). */
function pictures(page: Page, trainId: string): Promise<number> {
  return page.evaluate((tid) => {
    type N = { name: () => string; getClassName: () => string; find: (f: (n: N) => boolean) => N[] };
    const st = (window as unknown as { Konva: { stages: N[] } }).Konva.stages[0]!;
    return st.find((n) => n.name() === `train-${tid}`).flatMap((g) => g.find((n) => n.getClassName() === 'Image')).length;
  }, trainId);
}

type Saved = { rollingStock?: { id: string; number: string; kind: string; length: number; trucks: { at: number }[]; look: { mode: string; partKey?: string }; model?: { partKey?: string; file?: string; format?: string }; libraryId?: string }[]; trains?: { id: string }[] };
async function saved(page: Page, id: string): Promise<Saved> {
  const r = await page.request.get(`/api/layouts/${id}/export.bbm.bld`);
  return r.ok() ? ((await r.json()) as Saved) : {};
}

async function openTrains(page: Page) {
  if (await page.getByTestId('trains-panel').isVisible()) return;
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Trains', exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('trains-panel')).toBeVisible();
}

test('import a Studio model as an engine: the trucks are found, fixed by hand, and the engine runs with its picture', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const net = watch4xx(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, `trains-model-${Date.now()}@example.com`, 'Model Maker');
  const { id } = (await (await page.request.post('/api/layouts', { data: { title: 'Model engine', bbm: BBM } })).json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1000);
  await page.keyboard.press('f');
  await openTrains(page);
  await page.getByTestId('trains-tab-stock').click();
  await expect(page.getByTestId('trains-panel')).toContainText('Or bring in a model you built with Import a model…');

  await page.getByTestId('stock-import-input').setInputFiles({ name: 'Santa Fe engine.io', mimeType: 'application/octet-stream', buffer: Buffer.from(engineIo()) });
  const dialog = page.getByRole('dialog', { name: 'Import a model' });
  await expect(dialog.getByTestId('stock-setup')).toBeVisible({ timeout: 60000 });
  await expect(dialog).toContainText('Import a model as an engine or car');
  // The trucks on the bogie plates, the couplers on the magnets, and it says so.
  await expect(dialog.getByTestId('stock-guess-note')).toContainText('We found the trucks from the model’s bogies. The couplers are its magnets.');
  await expect(dialog.getByTestId('stock-front-at')).toHaveValue('9');
  await expect(dialog.getByTestId('stock-rear-at')).toHaveValue('-9');
  await expect(dialog.getByTestId('stock-length')).toHaveValue('30');
  await expect(dialog.getByLabel('Kind')).toHaveValue('engine');
  // Drag the front truck a stud forward, on the picture.
  const marker = dialog.getByTestId('stock-truck-front');
  const box = (await marker.boundingBox())!;
  const svg = (await dialog.getByTestId('stock-setup').locator('svg').boundingBox())!;
  const studPx = svg.width / (32 + 6);
  await page.mouse.move(box.x + box.width / 2, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + studPx / 2, box.y + 4);
  await page.mouse.move(box.x + box.width / 2 + studPx, box.y + 4);
  await page.mouse.up();
  await expect(dialog.getByTestId('stock-front-at')).toHaveValue('10');
  // The other end is the front: the trucks change ends.
  await dialog.getByTestId('stock-turn-around').click();
  await expect(dialog.getByTestId('stock-front-at')).toHaveValue('9');
  await expect(dialog.getByTestId('stock-rear-at')).toHaveValue('-10');
  await dialog.getByLabel('Road number').fill('SF 16');
  await dialog.getByTestId('stock-to-roster').getByRole('checkbox').check();
  await dialog.getByTestId('import-make').click();
  await expect(dialog).toHaveCount(0, { timeout: 60000 });
  await expect(page.getByRole('list', { name: 'Rolling stock' })).toContainText('SF 16');
  await expect(page.getByTestId('trains-panel')).toContainText('and put it on the roster', { timeout: 15000 });

  // Kept in the layout as a model car, its picture the custom part just made.
  await expect.poll(async () => (await saved(page, id)).rollingStock?.[0]?.libraryId ?? null, { timeout: 15000 }).not.toBeNull();
  const car = (await saved(page, id)).rollingStock![0]!;
  expect(car.kind).toBe('engine');
  expect(car.length).toBe(30);
  expect(car.trucks.map((t) => t.at)).toEqual([9, -10]);
  expect(car.look.mode).toBe('model');
  expect(car.look.partKey).toMatch(/^custom:[0-9a-f-]{36}$/);
  expect(car.model).toMatchObject({ partKey: car.look.partKey, file: 'Santa Fe engine.io', format: 'studio' });
  const roster = (await (await page.request.get('/api/rolling-stock')).json()) as { stock: { id: string; modelPartId: string | null }[] };
  expect(roster.stock.find((e) => e.id === car.libraryId)?.modelPartId).toBe(car.look.partKey!.slice('custom:'.length));

  // A train of it, on the track: drawn with the model's picture.
  await page.getByLabel('Pick SF 16 for a new train').check();
  await page.getByTestId('train-from-ticked').click();
  await expect.poll(async () => (await saved(page, id)).trains?.length ?? 0).toBe(1);
  const trainId = (await saved(page, id)).trains![0]!.id;
  await page.getByTestId('train-place').click();
  const p = await onPage(page, MID.x, MID.y);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => pictures(page, trainId), { timeout: 15000 }).toBe(1);

  // A second browser sees it, live, picture and all.
  const other = await browser.newContext();
  const theirs = await other.newPage();
  await theirs.setViewportSize({ width: 1400, height: 900 });
  await theirs.context().addCookies(await page.context().cookies());
  await theirs.goto(`/editor/${id}`);
  await expect(theirs.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await expect.poll(() => pictures(theirs, trainId), { timeout: 20000 }).toBe(1);
  await other.close();

  // A reload keeps it.
  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await openTrains(page);
  await expect.poll(() => pictures(page, trainId), { timeout: 15000 }).toBe(1);
  net.expectQuiet();
});
