// Journey: the editor's tools do what they say, in plain words.
//
//   Ada opens a new layout: the map says how to add the first part, and one
//   click on a part adds it. She picks Turn and clicks the part: it turns by
//   the turn step; Shift+click turns it back, and the status bar says
//   "Tool: Turn". With the Rulers sheet hidden she measures, and is told the
//   ruler went on a hidden sheet, with a button to show it. Erase on a map
//   with no painted ground says so and adds no sheet. T opens Add text.
//   Find & Replace asks before putting a part the library doesn't have on
//   the map. The Venue tab offers "Draw your venue" and its sizes take
//   meters. Alt+N goes to the New layout dialog; a module left with
//   changes can be saved on the way out.
//
// SHOTS=<dir> saves light and dark pictures of each step.

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { signIn, mapMenu } from '../../helpers';

const ts = Date.now();
const ADA = `j-tools-ada-${ts}@example.com`;
const PART = 'ts_narrowgauge_straight.8';
const SHOTS = process.env.SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
  }
}

/** The parts on the canvas, with where each one's middle is on screen. */
function bricks(page: Page): Promise<{ id: string; rot: number; sx: number; sy: number }[]> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string; rotation: () => number; getAbsolutePosition: () => { x: number; y: number } };
    const st = (window as unknown as { Konva?: { stages: { container: () => HTMLElement; find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    if (!st) return [];
    const box = st.container().getBoundingClientRect();
    return st
      .find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-'))
      .map((n) => {
        const a = n.getAbsolutePosition();
        return { id: n.name().slice(6), rot: n.rotation(), sx: box.left + a.x, sy: box.top + a.y };
      });
  });
}

async function newLayout(page: Page, title: string): Promise<string> {
  const res = await page.request.post('/api/layouts', { data: { title } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  return id;
}

async function findPart(page: Page): Promise<void> {
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
}

const orientation = async (page: Page, id: string): Promise<number> => {
  const xml = await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
  return Number(/<Orientation>([^<]+)<\/Orientation>/.exec(xml)?.[1]);
};

test.describe('tools that do what they say', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('one click adds the first part, Turn turns it, and hidden sheets and empty ground are explained', async ({ page }) => {
    await signIn(page, ADA, 'Ada Tools');
    const id = await newLayout(page, `Tools ${ts}`);
    const hint = page.getByTestId('empty-map-hint');
    await expect(hint).toContainText('Click a part in the Parts panel to add it');
    await findPart(page);
    await shot(page, 'empty-map-hint');

    // On an empty map, one click is enough.
    await page.locator(`[title*="(${PART})"]`).first().click();
    await expect.poll(async () => (await bricks(page)).length).toBe(1);
    await expect(hint).toHaveCount(0);
    // A second click picks it, and adds no other.
    await page.locator(`[title*="(${PART})"]`).first().click();
    await page.waitForTimeout(500);
    expect((await bricks(page)).length).toBe(1);

    // Turn: a click turns it by the step (90°), Shift+click turns it back.
    await page.getByRole('navigation', { name: 'Build tools' }).getByRole('button', { name: 'Turn', exact: true }).click();
    await expect(page.locator('footer')).toContainText('Tool: Turn');
    const [b] = await bricks(page);
    await page.mouse.click(b!.sx, b!.sy);
    await expect.poll(() => orientation(page, id)).toBe(90);
    await shot(page, 'turn-clicked');
    // Clicked again straight away: it turns again, no properties box.
    await page.mouse.click(b!.sx, b!.sy);
    await expect.poll(() => orientation(page, id)).toBe(180);
    await expect(page.getByRole('dialog', { name: 'Part properties' })).toHaveCount(0);
    await page.keyboard.down('Shift');
    await page.mouse.click(b!.sx, b!.sy);
    await page.mouse.click(b!.sx, b!.sy);
    await page.keyboard.up('Shift');
    await expect.poll(() => orientation(page, id)).toBe(0);

    // A ruler drawn while the Rulers sheet is hidden: told, with a way to show it.
    await page.getByRole('navigation', { name: 'Build tools' }).getByRole('button', { name: 'Measure', exact: true }).click();
    const box = (await page.locator('.konvajs-content').first().boundingBox())!;
    const drag = async (x0: number, y0: number, x1: number, y1: number) => {
      await page.mouse.move(box.x + x0, box.y + y0);
      await page.mouse.down();
      await page.mouse.move(box.x + x1, box.y + y1, { steps: 8 });
      // The preview follows on the next frame; let it catch up first.
      await page.waitForTimeout(250);
      await page.mouse.up();
    };
    await drag(100, 100, 300, 100);
    const sheets = page;
    const xml = async () => (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
    await expect.poll(async () => /<LinearRuler/.test(await xml())).toBe(true);
    await expect(sheets.getByLabel('Show Rulers')).toBeChecked();
    await sheets.getByLabel('Show Rulers').uncheck();
    await page.getByRole('navigation', { name: 'Build tools' }).getByRole('button', { name: 'Measure', exact: true }).click();
    await drag(100, 200, 300, 200);
    const notice = page.getByTestId('notice');
    await expect(notice).toContainText('Your ruler went on “Rulers”, which is hidden');
    await shot(page, 'ruler-on-hidden-sheet');
    await page.getByTestId('notice-action').click();
    await expect(sheets.getByLabel('Show Rulers')).toBeChecked();

    // Erase with no painted ground: said so, and no empty "Area" sheet.
    await page.getByRole('navigation', { name: 'Build tools' }).getByRole('button', { name: 'Erase', exact: true }).click();
    await page.mouse.click(box.x + 400, box.y + 300);
    await expect(notice).toContainText('There’s no painted ground to erase');
    await expect(sheets.getByLabel('Show Area')).toHaveCount(0);

    // T opens Add text (the browser keeps Ctrl+T for a new tab).
    await page.getByRole('navigation', { name: 'Build tools' }).getByRole('button', { name: 'Select', exact: true }).click();
    await page.mouse.click(box.x + 600, box.y + 400);
    await page.keyboard.press('t');
    const addText = page.getByRole('dialog', { name: 'Add text' });
    await expect(addText.getByLabel('Size (pt):')).toHaveValue('12');
    await expect(addText.getByText('Font:')).toHaveCount(0);
    await addText.getByRole('button', { name: 'Cancel' }).click();
  });

  test('Find & Replace asks before putting a part the library doesn’t have on the map', async ({ page }) => {
    await signIn(page, ADA, 'Ada Tools');
    const id = await newLayout(page, `Find ${ts}`);
    await findPart(page);
    await page.locator(`[title*="(${PART})"]`).first().click();
    await expect.poll(async () => (await bricks(page)).length).toBe(1);
    await page.keyboard.press('Control+f');
    const find = page.getByRole('dialog', { name: 'Find & Replace' });
    // Parts first, found by name too, with a picture.
    await expect(find.getByLabel('Find in')).toHaveValue('part');
    await find.getByPlaceholder('Search…').fill('narrow gauge');
    await expect(find).toContainText('1 match');
    await expect(find.locator('ul img')).toHaveCount(1);
    await find.getByPlaceholder('The new part’s number…').fill('nosuchpart.1');
    await find.getByRole('button', { name: 'Replace all' }).click();
    const ask = page.getByTestId('confirm-dialog');
    await expect(ask).toContainText('“nosuchpart.1” isn’t in the parts library');
    await shot(page, 'find-unknown-part');
    await ask.getByRole('button', { name: 'Go back' }).click();
    const xml = await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
    expect(xml.toLowerCase()).toContain(PART);
    expect(xml.toLowerCase()).not.toContain('nosuchpart');
  });

  test('the Venue tab offers to draw the venue, in meters too', async ({ page }) => {
    await signIn(page, ADA, 'Ada Tools');
    await newLayout(page, `Venue ${ts}`);
    await page.getByRole('group', { name: 'Tasks' }).getByRole('button', { name: 'Venue', exact: true }).click();
    const card = page.getByTestId('draw-venue-card');
    await expect(card).toContainText('Draw your venue');
    await shot(page, 'draw-venue-card');
    await card.getByRole('button', { name: 'Type in the sizes…' }).click();
    const dims = page.getByRole('dialog', { name: 'Draw venue outline by dimensions' });
    await dims.getByRole('combobox').first().selectOption('m');
    await dims.getByRole('button', { name: 'Rectangle preset…' }).click();
    await expect(dims.getByText('Width (E-W, m):')).toBeVisible();
    await dims.getByRole('button', { name: 'Apply' }).click();
    await dims.getByRole('button', { name: 'OK' }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save this layout’s venue…' })).toBeEnabled();
  });

  test('Alt+N opens New layout on Home, and Open another layout shows the list', async ({ page }) => {
    await signIn(page, ADA, 'Ada Tools');
    await newLayout(page, `Keys ${ts}`);
    await page.keyboard.press('Alt+n');
    await expect(page).toHaveURL(/\/\?new=1$/);
    await expect(page.getByRole('dialog', { name: 'New layout' })).toBeVisible();
    await page.goBack();
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: new RegExp(`Keys ${ts}`) }).first().click();
    await page.getByRole('menuitem', { name: 'Open another layout' }).click();
    await expect(page.getByTestId('pick-another')).toContainText('Pick a layout below to open it');
  });
});

test.describe('the module editor on the way out', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('leaving with changes offers Save and leave, and the module keeps its part', async ({ page }) => {
    await signIn(page, ADA, 'Ada Tools');
    const res = await page.request.post('/api/modules', { data: { title: `Siding ${ts}` } });
    const { id } = (await res.json()) as { id: string };
    await page.goto(`/modules/${id}`);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    await findPart(page);
    await page.locator(`[title*="(${PART})"]`).first().click();
    await expect.poll(async () => (await bricks(page)).length).toBe(1);
    await expect(page.getByTestId('save-status')).toHaveText('Not saved yet');

    // No browser "Leave site?" box: the app asks, once.
    let browserAsked = false;
    page.on('dialog', (d) => {
      browserAsked = true;
      void d.dismiss();
    });
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    const ask = page.getByTestId('confirm-dialog');
    await expect(ask).toContainText('If you leave without saving, they’re lost.');
    await expect(ask).not.toContainText('kept on this device');
    await shot(page, 'module-leave');
    await ask.getByRole('button', { name: 'Save and leave' }).click();
    await expect(page).toHaveURL(/\/$/);
    expect(browserAsked).toBe(false);

    await page.goto(`/modules/${id}`);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await bricks(page)).length).toBe(1);
  });
});

test.describe('words', () => {
  test('the export starts at a sendable size and says how big the file will be', async ({ page }) => {
    await signIn(page, ADA, 'Ada Tools');
    await newLayout(page, `Export ${ts}`);
    await findPart(page);
    await page.locator(`[title*="(${PART})"]`).first().click();
    await expect.poll(async () => (await bricks(page)).length).toBe(1);
    await page.evaluate(() => localStorage.removeItem('cld:exportImage'));
    await mapMenu(page, 'Download & export', 'Export as image…');
    const dialog = page.getByRole('dialog', { name: 'Export / Print' });
    const w = Number(await dialog.getByLabel('Width (px)').inputValue());
    const h = Number(await dialog.getByLabel('Height (px)').inputValue());
    expect(Math.max(w, h)).toBeLessThanOrEqual(4000);
    await expect(dialog.getByTestId('image-estimate')).toContainText(/The file will be about \d/);
    await expect(dialog.getByLabel('Add the author, club and event in the corner')).toBeVisible();
    await shot(page, 'export-estimate');
  });
});
