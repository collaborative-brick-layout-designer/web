// E2E: desktop-parity editor features — anchored-label placement, part-
// number Find & Replace, the rotate / z-order toolbar buttons, the View
// entries of the Map menu, "Download Layout", the Export Image options and
// the drop-target hint.
//
// Set SHOT_DIR to also save screenshots of the new controls.

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn, mapMenu } from '../helpers';

const FORDYCE_BBM = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm',
  ),
  'utf-8',
);

const EMAIL = `parity-e2e-${Date.now()}@example.com`;

async function createLayout(page: Page, bbm?: string): Promise<string> {
  await signIn(page, EMAIL, 'Parity Tester');
  const res = await page.request.post('/api/layouts', {
    data: bbm ? { title: 'Parity Test', bbm } : { title: 'Parity Test' },
  });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function openEditor(page: Page, id: string): Promise<void> {
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1000); // WS sync + first render settle
}

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.SHOT_DIR;
  if (dir) await page.screenshot({ path: join(dir, name) });
}

interface ExportedLabel {
  text: string;
  kind: number;
  targetId: string;
  offset: { x: number; y: number };
}

/** The layout's live sidecar labels, via the desktop-named sidecar export. */
async function exportedLabels(page: Page, id: string): Promise<ExportedLabel[]> {
  const res = await page.request.get(`/api/layouts/${id}/export.bbm.bld`);
  if (!res.ok()) return [];
  return ((await res.json()) as { anchoredLabels?: ExportedLabel[] }).anchoredLabels ?? [];
}

function countPart(bbm: string, part: string): number {
  return bbm.split(`<PartNumber>${part}</PartNumber>`).length - 1;
}

test.describe('anchored labels — default placement', () => {
  test('a World label is placed at the viewport centre', async ({ page }) => {
    const id = await createLayout(page);
    await openEditor(page, id);
    // Empty layout: no auto-fit, so the view is at pan 0 / zoom 1 and the
    // stage centre is (width/2, height/2) px = /8 studs.
    // The stage is the visible canvas area (header, rail, docks and status bar taken off).
    const { iw, ih } = await page.evaluate(() => {
      const st = (window as unknown as { Konva: { stages: { width: () => number; height: () => number }[] } }).Konva.stages[0]!;
      return { iw: st.width(), ih: st.height() };
    });
    const expected = {
      x: Math.round((iw / 2 / 8) * 100) / 100,
      y: Math.round((ih / 2 / 8) * 100) / 100,
    };

    await page.keyboard.press('Control+l');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Add Anchored Label');
    await dialog.locator('input[type="text"]').first().fill('Centre');
    await dialog.getByRole('button', { name: 'Add Label' }).click();

    await expect.poll(async () => (await exportedLabels(page, id)).map((l) => l.text)).toEqual(['Centre']);
    const [label] = await exportedLabels(page, id);
    expect(label!.kind).toBe(0);
    expect(label!.offset.x).toBeCloseTo(expected.x, 1);
    expect(label!.offset.y).toBeCloseTo(expected.y, 1);
  });

  test('a label on the selected brick defaults to offset (2, -2)', async ({ page }) => {
    const id = await createLayout(page, FORDYCE_BBM);
    await openEditor(page, id);

    // Select exactly one brick through Find (clicking a match selects it).
    await page.keyboard.press('Control+f');
    const find = page.getByRole('dialog');
    await find.getByLabel('Find in').selectOption('part');
    await find.getByPlaceholder('Search…').fill('3857.0');
    await find.locator('ul button').first().click();
    await find.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('footer')).toContainText('selected: 1');

    await page.keyboard.press('Control+l');
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('select')).toHaveValue('1');
    await dialog.locator('input[type="text"]').first().fill('On brick');
    await dialog.getByRole('button', { name: 'Add Label' }).click();

    await expect.poll(async () => (await exportedLabels(page, id)).length).toBe(1);
    const [label] = await exportedLabels(page, id);
    expect(label!.kind).toBe(1);
    expect(label!.targetId).not.toBe('');
    expect(label!.offset).toEqual({ x: 2, y: -2 });
  });
});

test.describe('find & replace — part numbers', () => {
  test('Replace changes the current match; Replace all the rest, as one undo step', async ({ page }) => {
    const id = await createLayout(page, FORDYCE_BBM);
    await openEditor(page, id);

    await page.keyboard.press('Control+f');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Find in').selectOption('part');
    await dialog.getByPlaceholder('Search…').fill('3857.0');
    await expect(dialog).toContainText('72 matches');
    // A part the library has (3857.2), so it isn't asked about.
    await dialog.getByPlaceholder('The new part’s number…').fill('3857.2');
    await shot(page, 'find-replace.png');

    await dialog.getByRole('button', { name: 'Replace', exact: true }).click();
    await expect(dialog).toContainText('71 matches');
    // Let the undo manager close its capture window so the two replaces
    // stay separate undo steps.
    await page.waitForTimeout(800);
    await dialog.getByRole('button', { name: 'Replace all' }).click();
    await expect(dialog).toContainText('No matches.');

    const bbm = () => page.request.get(`/api/layouts/${id}/export.bbm`).then((r) => r.text());
    await expect.poll(async () => countPart(await bbm(), '3857.2')).toBe(72);
    expect(countPart(await bbm(), '3857.0')).toBe(0);

    await dialog.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Undo' }).click();
    // Undo reverts the whole Replace all (71 bricks) in one step.
    await expect.poll(async () => countPart(await bbm(), '3857.0')).toBe(71);
    expect(countPart(await bbm(), '3857.2')).toBe(1);
  });
});

test.describe('toolbar and menus', () => {
  test('rotate / z-order buttons act on the selection', async ({ page }) => {
    // Four edits of all ~1000 Fordyce bricks, each synced; up to ~33 s on a dev machine.
    test.slow();
    const id = await createLayout(page, FORDYCE_BBM);
    await openEditor(page, id);

    const rotateCw = page.getByRole('button', { name: 'Turn right' });
    await expect(rotateCw).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Bring to front' })).toBeDisabled();

    await page.keyboard.press('Control+a');
    await expect(rotateCw).toBeEnabled();
    await shot(page, 'toolbar-buttons.png');
    await rotateCw.click();
    await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await page.getByRole('button', { name: 'Send to back' }).click();
    await page.getByRole('button', { name: 'Turn left' }).click();
    await page.getByRole('button', { name: 'Bring to front' }).click();
  });

  test('Map menu zoom entries, Insert Text and Download Layout', async ({ page }) => {
    const id = await createLayout(page, FORDYCE_BBM);
    await openEditor(page, id);
    const footer = page.locator('footer');
    const zoomText = async () => (await footer.innerText()).match(/Zoom: (\d+)%/)?.[1];

    const before = await zoomText();
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    await page.getByRole('menu', { name: 'Map' }).getByRole('menuitem', { name: 'View' }).hover();
    await shot(page, 'map-menu.png');
    await page.getByRole('menu', { name: 'View' }).getByRole('menuitem', { name: 'Zoom in' }).click();
    await expect.poll(zoomText).not.toBe(before);
    const zoomed = await zoomText();
    await mapMenu(page, 'View', 'Zoom out');
    await expect.poll(zoomText).not.toBe(zoomed);
    await mapMenu(page, 'View', 'Fit to view');

    await mapMenu(page, 'Insert', 'Text…');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

    const download = page.waitForEvent('download');
    await mapMenu(page, 'Download & export', 'Download layout (.bld-layout)');
    // The whole layout in one file (layoutFile.spec.ts looks inside).
    expect((await download).suggestedFilename()).toBe('Parity Test.bld-layout');
  });

  test('Export Image offers size, JPEG quality and antialias', async ({ page }) => {
    const id = await createLayout(page, FORDYCE_BBM);
    await openEditor(page, id);
    await mapMenu(page, 'Download & export', 'Export as image…');

    const width = page.getByLabel('Width (px)');
    const height = page.getByLabel('Height (px)');
    await expect(height).toBeDisabled(); // keep aspect on
    await width.fill('800');
    const autoH = Number(await height.inputValue());
    expect(autoH).toBeGreaterThan(0);
    await page.getByLabel('Keep aspect ratio (height auto)').uncheck();
    await height.fill('300');
    await page.locator('select').filter({ hasText: 'JPEG' }).selectOption('jpeg');
    await expect(page.getByLabel('JPEG quality')).toBeVisible();
    await expect(page.getByLabel('Antialias')).toBeChecked();
    await shot(page, 'export-image.png');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export JPEG' }).click();
    expect((await download).suggestedFilename()).toBe('Parity Test.jpg');
  });
});

test.describe('drag and drop', () => {
  test('dragging a part over the canvas shows the drop-target layer', async ({ page }) => {
    const id = await createLayout(page, FORDYCE_BBM);
    await openEditor(page, id);
    const part = page.locator('aside li button[draggable="true"]').first();
    await expect(part).toBeVisible({ timeout: 10000 });
    const stage = page.locator('.konvajs-content').first();
    const box = (await stage.boundingBox())!;

    await part.hover();
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 10, { steps: 4 });
    await expect(page.locator('footer')).toContainText('Drop onto: ');
    await shot(page, 'drop-hint.png');
    await page.mouse.up();
    await expect(page.locator('footer')).not.toContainText('Drop onto: ');
  });
});

test.describe('module drag ghost', () => {
  test('dragging a library module draws its ghost, then drops it', async ({ page }) => {
    // Loads the Fordyce map twice (source and module); up to ~30 s on a dev machine.
    test.slow();
    // A module made from the Fordyce layout's snapshot.
    const sourceId = await createLayout(page, FORDYCE_BBM);
    const snapshot = await (await page.request.get(`/api/layouts/${sourceId}/snapshot`)).body();
    const mod = await page.request.post('/api/modules', { data: { title: 'Fordyce Loop' } });
    const { id: moduleId } = (await mod.json()) as { id: string };
    const put = await page.request.put(`/api/modules/${moduleId}/snapshot`, {
      data: snapshot,
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(put.ok()).toBe(true);

    const hostId = await createLayout(page);
    await openEditor(page, hostId);
    await page.getByRole('button', { name: 'Panels', exact: true }).click();
    await page.getByLabel('Module library').check();
    await page.mouse.click(400, 400); // click-away backdrop closes the menu
    const row = page.locator('li[draggable="true"]', { hasText: 'Fordyce Loop' });
    await expect(row).toBeVisible({ timeout: 10000 });
    // Zoom out so the whole (~1150-stud-wide) module fits in view.
    for (let i = 0; i < 14; i++) await page.keyboard.press('Control+-');

    const stage = page.locator('.konvajs-content').first();
    const box = (await stage.boundingBox())!;
    const hud = page.locator('.konvajs-content canvas').last();
    const hudInk = () =>
      hud.evaluate((el: HTMLCanvasElement) => {
        const d = el.getContext('2d')!.getImageData(0, 0, el.width, el.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4 * 13) if (d[i]! > 0) n++;
        return n;
      });
    const inkBefore = await hudInk();

    await row.hover();
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    await expect(page.locator('footer')).toContainText('Drop onto: ');
    // Nudge so a dragover fires after the snapshot has loaded.
    for (let i = 1; i <= 5; i++) {
      await page.waitForTimeout(300);
      await page.mouse.move(box.x + box.width / 2 + i * 4, box.y + box.height / 2 + i * 2);
    }
    await expect.poll(hudInk).toBeGreaterThan(inkBefore + 100);
    await shot(page, 'module-ghost.png');
    await page.mouse.up();

    // The module's two sheets aren't in the empty layout: the drop asks
    // where they go, the picked sheet by default.
    const where = page.getByTestId('sheet-choice-dialog');
    await expect(where).toContainText('Where should these go?');
    await expect(where).toContainText('“Fordyce Loop” uses 2 sheets.');
    await where.getByRole('button', { name: 'Place' }).click();

    // The drop selects the imported bricks. (The "Imported …" status
    // message fades after a moment, so it is not a reliable check.)
    await expect(page.locator('footer')).toContainText(/selected: \d{3,}/);
    const bbm = await (await page.request.get(`/api/layouts/${hostId}/export.bbm`)).text();
    expect(bbm.split('<Brick id=').length - 1).toBeGreaterThan(900);
  });
});

test.describe('anchored labels — color round-trip', () => {
  test('editing a label with a known color keeps the color in the doc', async ({ page }) => {
    await signIn(page, EMAIL, 'Parity Tester');
    const sidecar = JSON.stringify({
      schemaVersion: 1,
      bbmHashSha256: '',
      anchoredLabels: [{
        id: '4242', text: 'Color Test', font: { family: 'Arial', size: 24, style: 'Regular' },
        color: { known: true, argb: 4294901760, name: 'Red' },
        kind: 0, targetId: '', offset: { x: 40, y: 30 }, rot: 0, minZoom: 0,
      }],
    });
    const res = await page.request.post('/api/layouts', { data: { title: 'Parity Test', sidecar } });
    const { id } = (await res.json()) as { id: string };
    await openEditor(page, id);

    // The view fits to the label on open; its top-left is at (40, 30)
    // studs = (320, 240) scene px, mapped through the stage transform.
    const box = (await page.locator('.konvajs-content').first().boundingBox())!;
    const t = await page.evaluate(() => {
      const st = (window as unknown as { Konva: { stages: { x: () => number; y: () => number; scaleX: () => number }[] } }).Konva.stages[0]!;
      return { x: st.x(), y: st.y(), z: st.scaleX() };
    });
    await page.mouse.dblclick(box.x + t.x + (320 + 6) * t.z, box.y + t.y + (240 + 6) * t.z);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Edit Anchored Label');
    await expect(dialog.locator('input[type="color"]')).toHaveValue('#ff0000');
    await dialog.locator('input[type="text"]').first().fill('Color Kept');
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect.poll(async () => (await exportedLabels(page, id))[0]?.text).toBe('Color Kept');
    const raw = await (await page.request.get(`/api/layouts/${id}/export.bbm.bld`)).json() as {
      anchoredLabels: { id: string; color: unknown }[];
    };
    expect(raw.anchoredLabels[0]!.id).toBe('4242');
    expect(raw.anchoredLabels[0]!.color).toEqual({ known: true, argb: 4294901760, name: 'Red' });
  });
});

test.describe('insert text', () => {
  test('Map → Insert Text places the text at the view centre', async ({ page }) => {
    const id = await createLayout(page);
    await openEditor(page, id);
    // The stage is the visible canvas area (header, rail, docks and status bar taken off).
    const { iw, ih } = await page.evaluate(() => {
      const st = (window as unknown as { Konva: { stages: { width: () => number; height: () => number }[] } }).Konva.stages[0]!;
      return { iw: st.width(), ih: st.height() };
    });
    const centre = { x: iw / 2 / 8, y: ih / 2 / 8 };

    await mapMenu(page, 'Insert', 'Text…');
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[type="text"], textarea').first().fill('Centred');
    await dialog.getByRole('button', { name: 'OK' }).click();

    const cell = async () => {
      const bbm = await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
      const m = /<TextCell>\s*<DisplayArea>\s*<X>([^<]+)<\/X>\s*<Y>([^<]+)<\/Y>\s*<Width>([^<]+)<\/Width>\s*<Height>([^<]+)<\/Height>/.exec(bbm);
      return m ? { x: Number(m[1]) + Number(m[3]) / 2, y: Number(m[2]) + Number(m[4]) / 2 } : null;
    };
    await expect.poll(cell).not.toBeNull();
    const c = (await cell())!;
    expect(c.x).toBeCloseTo(centre.x, 1);
    expect(c.y).toBeCloseTo(centre.y, 1);
  });

  test('T puts Arial 12 black text at the view centre on a Labels layer, whatever the mouse', async ({ page }) => {
    const id = await createLayout(page);
    await openEditor(page, id);
    // The stage is the visible canvas area (header, rail, docks and status bar taken off).
    const { iw, ih } = await page.evaluate(() => {
      const st = (window as unknown as { Konva: { stages: { width: () => number; height: () => number }[] } }).Konva.stages[0]!;
      return { iw: st.width(), ih: st.height() };
    });
    const centre = { x: iw / 2 / 8, y: ih / 2 / 8 };
    // Mouse over the canvas, well away from its centre.
    const box = (await page.locator('.konvajs-content').first().boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 40);

    await page.keyboard.press('t');
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[type="text"], textarea').first().fill('Yard');
    await dialog.getByRole('button', { name: 'OK' }).click();

    const bbm = () => page.request.get(`/api/layouts/${id}/export.bbm`).then((r) => r.text());
    await expect.poll(async () => /<TextCell>/.test(await bbm())).toBe(true);
    const xml = await bbm();
    const cellXml = xml.slice(xml.indexOf('<TextCell>'), xml.indexOf('</TextCell>'));
    const num = (tag: string) => Number(new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(cellXml)![1]);
    expect(num('X') + num('Width') / 2).toBeCloseTo(centre.x, 1);
    expect(num('Y') + num('Height') / 2).toBeCloseTo(centre.y, 1);
    expect(num('Height')).toBe(10);
    expect(num('Width')).toBe(24); // max(10 * 0.6 * 4 characters, 20)
    expect(cellXml).toMatch(/<FontColor>\s*<IsKnownColor>true<\/IsKnownColor>\s*<Name>Black<\/Name>/);
    expect(cellXml).toMatch(/<Size>12<\/Size>/);
    expect(xml).toMatch(/<Layer type="text" id="[^"]+">\s*<Name>Labels<\/Name>/);
  });
});

test.describe('venue library', () => {
  test('Rename on the selected venue lists the new name', async ({ page }) => {
    const id = await createLayout(page);
    const name = `Hall ${Date.now()}`;
    const created = await page.request.post('/api/venues', {
      data: { name, data: { name, enabled: true, minWalkwayStuds: 0, bounds: { x: 0, y: 0, w: 0, h: 0 }, edges: [], obstacles: [] } },
    });
    expect(created.ok()).toBe(true);
    await openEditor(page, id);
    await page.getByRole('button', { name: 'Panels', exact: true }).click();
    await page.getByLabel('Venue library').check();
    await page.mouse.click(400, 400); // close the menu

    const renamed = `${name} (main)`;
    await page.getByRole('option', { name }).click();
    await expect(page.getByTestId('venue-detail')).toContainText('0 wall seg · 0 door · 0 obstacle');
    await page.getByRole('button', { name: 'Rename…' }).click();
    const box = page.getByRole('dialog', { name: 'Rename venue' });
    await box.getByRole('textbox').fill(renamed);
    await box.getByRole('button', { name: 'Rename' }).click();
    await expect(box).toHaveCount(0);
    await expect(page.getByText(renamed, { exact: true })).toBeVisible();
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    await shot(page, 'venue-rename.png');
    const list = await (await page.request.get('/api/venues')).json() as { venues: { name: string }[] };
    expect(list.venues.map((v) => v.name)).toContain(renamed);
  });
});

test.describe('budget limits', () => {
  test('a limit persists across reload and other sessions, and .bbb save / open still work', async ({ page, browser }) => {
    // Loads the 500-brick Fordyce map more than once; ~25-35 s on a dev machine.
    test.slow();
    const id = await createLayout(page, FORDYCE_BBM);
    await openEditor(page, id);
    const openBudget = async (p: Page) => {
      await mapMenu(p, 'Budget', 'Edit budget…');
    };
    // The Budget table's first row (the Parts filter also uses a '—' placeholder).
    const budgetRow = (p: Page) => p.locator('tbody tr').filter({ has: p.locator('input[placeholder="—"]') }).first();
    const limitInput = (p: Page) => budgetRow(p).locator('input[placeholder="—"]');
    await openBudget(page);
    await limitInput(page).fill('5');
    const part = await budgetRow(page).locator('td').first().innerText();
    await expect(page.locator('footer')).toContainText('Budget: ');

    await page.waitForTimeout(500); // let the update reach the server
    await page.reload();
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    await openBudget(page);
    await expect(limitInput(page)).toHaveValue('5');

    // Another session sees the shared limit.
    const ctx2 = await browser.newContext();
    await signIn(ctx2, EMAIL);
    const page2 = await ctx2.newPage();
    await openEditor(page2, id);
    await openBudget(page2);
    await expect(limitInput(page2)).toHaveValue('5');
    await ctx2.close();

    // .bbb export carries the limit…
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save…' }).click();
    const download = await dl;
    const file = await download.path();
    const xml = readFileSync(file, 'utf-8');
    // Vanilla BlueBrick's layout (Budget.cpp): <PartList><Part id="…">N</Part>, CRLF.
    expect(xml).toContain(`    <Part id="${part}">5</Part>\r\n`);
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\r\n<Budget>\r\n')).toBe(true);

    // …and importing it restores the limit after New cleared it.
    await page.getByRole('button', { name: 'New', exact: true }).last().click();
    await expect(limitInput(page)).toHaveValue('');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Open…' }).click();
    await (await chooser).setFiles(file);
    await expect(limitInput(page)).toHaveValue('5');
  });
});

test.describe('header dropdowns at a narrow viewport', () => {
  test.use({ viewport: { width: 1024, height: 700 } });

  test('Map and Panels menus open fully inside the viewport', async ({ page }) => {
    const id = await createLayout(page, FORDYCE_BBM);
    await openEditor(page, id);
    const inside = async (menu: import('@playwright/test').Locator) => {
      await expect(menu).toBeVisible();
      const b = (await menu.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(1024);
      expect(b.y + b.height).toBeLessThanOrEqual(700);
      expect(b.height).toBeGreaterThan(100);
    };

    await page.getByRole('button', { name: 'Map', exact: true }).click();
    const mapList = page.getByRole('menu', { name: 'Map' });
    await inside(mapList);
    await expect(page.getByRole('menuitem', { name: 'Preferences…' })).toBeInViewport();
    // A submenu opens beside its entry and stays inside the window too.
    await mapList.getByRole('menuitem', { name: 'Download & export' }).hover();
    await expect(page.getByRole('menu', { name: 'Download & export' })).toBeVisible();
    const sub = (await page.getByRole('menu', { name: 'Download & export' }).boundingBox())!;
    expect(sub.x + sub.width).toBeLessThanOrEqual(1024);
    expect(sub.y + sub.height).toBeLessThanOrEqual(700);
    await shot(page, 'map-menu-1024.png');
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    await expect(mapList).toHaveCount(0);

    await page.getByRole('button', { name: 'Panels', exact: true }).click();
    const panelsMenu = page.locator('ul', { has: page.getByLabel('Module library') });
    await inside(panelsMenu);
  });
});

test.describe('find — modeless', () => {
  test('selects every match live and leaves the editor usable while open', async ({ page }) => {
    const id = await createLayout(page, FORDYCE_BBM);
    await openEditor(page, id);

    await page.keyboard.press('Control+f');
    const find = page.getByRole('dialog', { name: 'Find & Replace' });
    await find.getByLabel('Find in').selectOption('part');
    await find.getByPlaceholder('Search…').fill('3857.0');
    // No click on a result: typing alone selects all 72 matches.
    await expect(page.locator('footer')).toContainText('selected: 72');
    await shot(page, 'find-modeless.png');

    // The toolbar still works with the panel open (no modal backdrop).
    await page.getByRole('button', { name: 'Turn right' }).click();
    await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await expect(find).toBeVisible();

    await find.getByPlaceholder('Search…').fill('');
    await expect(page.locator('footer')).not.toContainText('selected: 72');
    await find.press('Escape');
    await expect(find).toHaveCount(0);
  });
});

test.describe('venue drawing', () => {
  test('fewer than 3 points is refused; a finished outline enables the venue and shows its status', async ({ page }) => {
    const id = await createLayout(page, FORDYCE_BBM);
    await openEditor(page, id);
    const footer = page.locator('footer');
    const box = (await page.locator('.konvajs-content').first().boundingBox())!;
    const at = (dx: number, dy: number) => page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);

    await mapMenu(page, 'Venue', 'Draw outline…');
    await at(-40, -40);
    await at(40, -40);
    await page.keyboard.press('Enter');
    await expect(footer).toContainText('Venue polygon needs at least 3 points');
    expect(((await (await page.request.get(`/api/layouts/${id}/export.bbm.bld`)).json()) as { venue?: unknown }).venue ?? null).toBeNull();

    // Still in the tool: a small triangle in the middle of the layout
    // finishes the outline, and most of the layout lies outside it.
    await at(-40, -40);
    await at(40, -40);
    await at(0, 40);
    await page.keyboard.press('Enter');
    await expect(footer).toContainText(/Venue: \d+ issue\(s\)/);
    await shot(page, 'venue-status.png');

    const venue = async () =>
      ((await (await page.request.get(`/api/layouts/${id}/export.bbm.bld`)).json()) as {
        venue?: { enabled: boolean; edges: unknown[]; minWalkwayStuds: number };
      }).venue;
    await expect.poll(async () => (await venue())?.edges.length).toBe(3);
    const v = (await venue())!;
    expect(v.enabled).toBe(true);
    expect(v.minWalkwayStuds).toBe(112.5);
  });
});

/** Entries of a stored (uncompressed) zip, read through its central directory. */
const LABEL_SIDECAR = JSON.stringify({
  schemaVersion: 1,
  bbmHashSha256: '',
  anchoredLabels: [{
    id: '777', text: 'Sidecar Label', font: { family: 'Arial', size: 24, style: 'Regular' },
    color: { known: true, argb: 4278190080, name: 'Black' },
    kind: 0, targetId: '', offset: { x: 10, y: 10 }, rot: 0, minZoom: 0,
  }],
});

test.describe('.bbm with its .bbm.bld sidecar', () => {
  test('dropping a .bbm together with its .bbm.bld opens a layout with both', async ({ page }) => {
    await signIn(page, EMAIL, 'Parity Tester');
    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();

    await page.evaluate(
      ({ bbm, sidecar }) => {
        const dt = new DataTransfer();
        dt.items.add(new File([bbm], 'dropped.bbm', { type: 'application/xml' }));
        dt.items.add(new File([sidecar], 'dropped.bbm.bld', { type: 'application/json' }));
        window.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      },
      { bbm: FORDYCE_BBM, sidecar: LABEL_SIDECAR },
    );

    await expect(page).toHaveURL(/\/editor\/[^/]+$/, { timeout: 15000 });
    const id = page.url().split('/editor/')[1]!;
    await expect.poll(async () => (await exportedLabels(page, id)).map((l) => l.text)).toEqual(['Sidecar Label']);
    const bbm = await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
    expect(countPart(bbm, '3857.0')).toBe(72);
  });
});

test.describe('scale bar', () => {
  test('bottom-left, in studs over mm / m, and it follows the zoom', async ({ page }) => {
    const id = await createLayout(page);
    await openEditor(page, id);
    const bar = page.getByTestId('scale-bar');
    // Empty map → zoom 1 (8 px per stud): the 120 px target picks 16 studs.
    await expect(bar).toHaveText(/16 studs\s*128 mm/);
    // Lower-left of the visible canvas: next to its left edge, just above the status bar.
    const canvas = (await page.locator('.konvajs-content').first().boundingBox())!;
    const footer = (await page.locator('footer').boundingBox())!;
    const b = (await bar.boundingBox())!;
    expect(b.x - canvas.x).toBeLessThan(20);
    expect(footer.y - (b.y + b.height)).toBeGreaterThanOrEqual(0);
    expect(footer.y - (b.y + b.height)).toBeLessThan(20);

    for (let i = 0; i < 6; i++) await page.keyboard.press('Control+-');
    await expect(bar).not.toHaveText(/16 studs/);
    await expect(bar).toHaveText(/\d+ studs\s*(\d+ mm|\d+\.\d\d m)/);
  });
});

test.describe('use budget limitation', () => {
  test('duplicate over budget is refused with the Budget reached box, then status only', async ({ page }) => {
    test.slow();
    const id = await createLayout(page, FORDYCE_BBM);
    await openEditor(page, id);
    const bbm = () => page.request.get(`/api/layouts/${id}/export.bbm`).then((r) => r.text());

    // Budget 3857.0 at exactly its 72 uses, and turn the limitation on.
    await mapMenu(page, 'Budget', 'Edit budget…');
    const row = page.locator('tbody tr', { hasText: '3857.0' });
    await row.locator('input[placeholder="—"]').fill('72');
    await mapMenu(page, 'Budget', 'Stop at the budget limits');
    // Close the Budget panel so it doesn't cover the Find panel.
    await mapMenu(page, 'Budget', 'Edit budget…');

    // Select one 3857.0 through Find, then duplicate it.
    await page.keyboard.press('Control+f');
    const find = page.getByRole('dialog', { name: 'Find & Replace' });
    await find.getByLabel('Find in').selectOption('part');
    await find.getByPlaceholder('Search…').fill('3857.0');
    await find.locator('ul button').first().click();
    await find.getByRole('button', { name: 'Close' }).click();
    await expect(page.locator('footer')).toContainText('selected: 1');

    await page.keyboard.press('Control+d');
    const box = page.getByRole('dialog', { name: 'Budget reached' });
    await expect(box).toBeVisible();
    await expect(page.locator('footer')).toContainText('Budget reached: part not added');
    await shot(page, 'budget-reached.png');
    await box.getByLabel("Don't show this message again").check();
    await box.getByRole('button', { name: 'OK' }).click();
    await expect(box).toHaveCount(0);

    // Again: refused silently apart from the status bar.
    await page.keyboard.press('Control+d');
    await expect(page.locator('footer')).toContainText('Budget reached: part not added');
    await expect(box).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(countPart(await bbm(), '3857.0')).toBe(72);
  });
});

test.describe('budget in the parts panel', () => {
  test('Show Budget Numbers and Show Only Budgeted Parts', async ({ page }) => {
    test.slow();
    const id = await createLayout(page, FORDYCE_BBM);
    await openEditor(page, id);
    const tiles = page.locator('aside li button[draggable="true"]');
    await expect(tiles.first()).toBeVisible({ timeout: 10000 });
    const allTiles = await tiles.count();

    await mapMenu(page, 'Budget', 'Edit budget…');
    await page.locator('tbody tr', { hasText: '3857.0' }).locator('input[placeholder="—"]').fill('10');
    await mapMenu(page, 'Budget', 'Edit budget…'); // close the panel

    await mapMenu(page, 'Budget', 'Show only parts in the budget');
    // Only parts with a limit above 0 remain: 3857.0.
    await expect(tiles).toHaveCount(1);
    await expect(tiles.first()).toHaveAttribute('title', /3857\.0/);

    await mapMenu(page, 'Budget', 'Show budget numbers');
    await expect(tiles.first().getByTestId('budget-numbers')).toHaveText('72/10');
    await expect(tiles.first()).toHaveClass(/bg-red-900/);
    await shot(page, 'parts-budget.png');

    await mapMenu(page, 'Budget', 'Show only parts in the budget');
    await expect(tiles).toHaveCount(allTiles);
    // Unbudgeted parts read "used/?".
    await expect(page.getByTestId('budget-numbers').filter({ hasText: /\/\?$/ }).first()).toBeVisible();
  });
});

test.describe('pivot geometry', () => {
  test('a part with a <hull> is placed with its footprint box and turns around its sprite centre', async ({ page }) => {
    const { footprint } = await import('@cld/parts-catalog');
    const id = await createLayout(page);
    await openEditor(page, id);
    const catalog = (await (await page.request.get('/api/parts/catalog')).json()) as {
      parts: { key: string; pxPerStud: number; spriteSize?: { w: number; h: number }; hullPts: { x: number; y: number }[] }[];
    };
    const part = catalog.parts.find((p) => p.key === '2861.8')!;
    expect(part.hullPts.length).toBeGreaterThan(0);
    expect(part.spriteSize).toBeTruthy();

    await page.getByPlaceholder('Search parts (name or number)').fill('2861.8');
    await page.locator('aside li button[draggable="true"]', { hasText: /./ }).filter({ has: page.locator('img') }).first().dblclick();

    const brick = async () => {
      const xml = await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
      const m = /<Brick id="[^"]+">[\s\S]*?<DisplayArea>\s*<X>([^<]+)<\/X>\s*<Y>([^<]+)<\/Y>\s*<Width>([^<]+)<\/Width>\s*<Height>([^<]+)<\/Height>[\s\S]*?<Orientation>([^<]+)<\/Orientation>/.exec(xml);
      return m ? { x: +m[1]!, y: +m[2]!, w: +m[3]!, h: +m[4]!, o: +m[5]! } : null;
    };
    await expect.poll(brick).not.toBeNull();
    const placed = (await brick())!;
    const fp0 = footprint(part, placed.o)!;
    expect(placed.w).toBeCloseTo(fp0.size.w, 3);
    expect(placed.h).toBeCloseTo(fp0.size.h, 3);
    const pivot0 = { x: placed.x + placed.w / 2 + fp0.imageOffset.x, y: placed.y + placed.h / 2 + fp0.imageOffset.y };

    await page.getByRole('button', { name: 'Turn right' }).click();
    await expect.poll(async () => (await brick())?.o).not.toBe(placed.o);
    const turned = (await brick())!;
    const fp1 = footprint(part, turned.o)!;
    expect(turned.w).toBeCloseTo(fp1.size.w, 3);
    expect(turned.h).toBeCloseTo(fp1.size.h, 3);
    // The sprite centre stays put: the brick turned in place.
    expect(turned.x + turned.w / 2 + fp1.imageOffset.x).toBeCloseTo(pivot0.x, 2);
    expect(turned.y + turned.h / 2 + fp1.imageOffset.y).toBeCloseTo(pivot0.y, 2);
  });
});

test.describe('chained placement', () => {
  test('double-clicking a track tile three times builds a straight run, each piece on the last one\'s free end', async ({ page }) => {
    const id = await createLayout(page);
    await openEditor(page, id);
    await page.getByPlaceholder('Search parts (name or number)').fill('2865.8');
    const tile = page.locator('aside li button[draggable="true"]').filter({ has: page.locator('img') }).first();
    await expect(tile).toHaveAttribute('title', /2865\.8/);

    const bricks = async () => {
      const xml = await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
      return [...xml.matchAll(/<Brick id="([^"]+)">[\s\S]*?<X>([^<]+)<\/X>\s*<Y>([^<]+)<\/Y>[\s\S]*?<\/Brick>/g)].map((m) => ({
        id: m[1]!,
        x: Number(m[2]),
        y: Number(m[3]),
        links: [...m[0].matchAll(/<LinkedTo>([^<]+)<\/LinkedTo>/g)].length,
      }));
    };
    // On an empty map one click adds the first piece (both apps); after that a
    // single click only picks the tile, and a double-click adds the next.
    await tile.click();
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(async () => (await bricks()).length).toBe(1);
    await tile.click();
    await page.waitForTimeout(500);
    expect(await bricks()).toHaveLength(1);
    for (let n = 2; n <= 3; n++) {
      await tile.dblclick();
      await expect.poll(async () => (await bricks()).length).toBe(n);
    }
    // Wait for the links to reach the server.
    await expect.poll(async () => (await bricks()).reduce((s, b) => s + b.links, 0)).toBe(4);
    const run = await bricks();
    const xs = run.map((b) => b.x).sort((a, b) => a - b);
    // Three 16-stud pieces in a row: no piece placed on top of another.
    expect(xs[1]! - xs[0]!).toBeCloseTo(16, 3);
    expect(xs[2]! - xs[1]!).toBeCloseTo(16, 3);
    expect(new Set(run.map((b) => b.y.toFixed(3))).size).toBe(1);
    // The middle piece is linked at both ends, the outer ones at one.
    expect(run.map((b) => b.links).sort()).toEqual([1, 1, 2]);
  });
});

test.describe('placing a set', () => {
  test('a set lands as one BlueBrick group named after it, its pieces linked and picked whole', async ({ page }) => {
    const id = await createLayout(page);
    await openEditor(page, id);
    await page.getByPlaceholder('Search parts (name or number)').fill('rail_yard_left_turn');
    const tile = page.locator('aside li button[draggable="true"]').filter({ hasText: /Rail yard/ }).first();
    await expect(tile).toBeVisible({ timeout: 10000 });
    // Enter on the focused tile adds it, like a double-click (PartsBrowser.cpp:145).
    await tile.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('footer')).toContainText('Placed set: Rail yard on the right (12 parts)');
    await expect(page.locator('footer')).toContainText('selected: 12');

    // Saved the way desktop's Group(string) builds it: one <Group> whose
    // PartNumber is the set, every piece's <MyGroup> naming it, no module.
    const bbm = async () => (await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text());
    const groupsOf = (xml: string) => [...xml.matchAll(/<Group id="([^"]+)">\s*<PartNumber>([^<]+)<\/PartNumber>/g)].map((m) => ({ id: m[1]!, part: m[2]! }));
    await expect.poll(async () => groupsOf(await bbm()).map((g) => g.part)).toEqual(['RAIL_YARD_LEFT_TURN']);
    const xml = await bbm();
    const groupId = groupsOf(xml)[0]!.id;
    expect(xml.split(`<MyGroup>${groupId}</MyGroup>`).length - 1).toBe(12);
    const sidecar = (await (await page.request.get(`/api/layouts/${id}/export.bbm.bld`)).json()) as { modules?: unknown[] };
    expect(sidecar.modules ?? []).toEqual([]);
    // Set files carry positions only; the pieces are linked on placement.
    await expect.poll(async () => ((await bbm()).match(/<LinkedTo>[^<]+<\/LinkedTo>/g) ?? []).length).toBeGreaterThanOrEqual(22);

    // A click on one piece picks the whole set.
    const first = /<Brick id="[^"]+">[\s\S]*?<X>([^<]+)<\/X>\s*<Y>([^<]+)<\/Y>\s*<Width>([^<]+)<\/Width>\s*<Height>([^<]+)<\/Height>/.exec(xml)!;
    const centre = { x: +first[1]! + +first[3]! / 2, y: +first[2]! + +first[4]! / 2 };
    const stage = page.locator('.konvajs-content').first();
    await stage.click({ position: { x: 5, y: 5 } });
    await expect(page.locator('footer')).not.toContainText('selected:');
    const t = await page.evaluate(() => {
      const st = (window as unknown as { Konva: { stages: { x: () => number; y: () => number; scaleX: () => number }[] } }).Konva.stages[0]!;
      return { x: st.x(), y: st.y(), z: st.scaleX() };
    });
    await stage.click({ position: { x: t.x + centre.x * 8 * t.z, y: t.y + centre.y * 8 * t.z } });
    await expect(page.locator('footer')).toContainText('selected: 12');
  });
});

test.describe('connection points', () => {
  test('free connection dots show only on the selected brick by default', async ({ page }) => {
    const id = await createLayout(page);
    await openEditor(page, id);
    // Dots a part draws itself (the Connection Points view), plus the
    // picked parts' dots the selection overlay drew last.
    const dots = () =>
      page.evaluate(() => {
        type Node = { getClassName: () => string; isVisible: () => boolean; getParent: () => { name: () => string } | null; attrs: { drawn?: { dots: number } } };
        const K = (window as unknown as { Konva: { stages: { find: (s: string | ((n: Node) => boolean)) => Node[] }[] } }).Konva;
        const own = K.stages
          .flatMap((st) => st.find((n: Node) => n.getClassName() === 'Circle'))
          .filter((c) => c.isVisible() && (c.getParent()?.name() ?? '').startsWith('brick-')).length;
        const overlay = K.stages.flatMap((st) => st.find('.selection-overlay')).reduce((n, o) => n + (o.attrs.drawn?.dots ?? 0), 0);
        return own + overlay;
      });

    // A placed piece is selected: its two free ends show.
    await page.getByPlaceholder('Search parts (name or number)').fill('2865.8');
    await page.locator('aside li button[draggable="true"]').filter({ has: page.locator('img') }).first().dblclick();
    await expect(page.locator('footer')).toContainText('selected: 1');
    await expect.poll(dots).toBe(2);

    // Deselected: none, since Connection Points is off by default.
    await page.locator('.konvajs-content').first().click({ position: { x: 20, y: 20 } });
    await expect(page.locator('footer')).not.toContainText('selected: 1');
    await expect.poll(dots).toBe(0);
  });
});

test.describe('unresolved parts', () => {
  test('parts the library lacks draw as BlueBrick\'s red-cross placeholder', async ({ page }) => {
    // Fordyce with one more brick renamed to a part no library has.
    const bbm = FORDYCE_BBM.replace('<PartNumber>3857.0</PartNumber>', '<PartNumber>NO_SUCH_PART.1</PartNumber>');
    const id = await createLayout(page, bbm);
    await openEditor(page, id);
    // Bricks whose part the catalog can't resolve by key, part number or old name.
    const catalog = (await (await page.request.get('/api/parts/catalog')).json()) as {
      parts: { key: string; partNumber: string; oldNames?: string[] }[];
    };
    const known = new Set(catalog.parts.flatMap((p) => [p.key, p.partNumber, ...(p.oldNames ?? [])].map((k) => k.toLowerCase())));
    const unknown = [...bbm.matchAll(/<PartNumber>([^<]+)<\/PartNumber>/g)].filter((m) => !known.has(m[1]!.toLowerCase())).length;
    expect(unknown).toBeGreaterThan(0);

    // Vanilla's unknown-part picture (BrickLibrary.cs createUnknownImage):
    // a clear box, a red cross corner to corner, the part number in black.
    const placeholders = () =>
      page.evaluate(() => {
        type Node = { getClassName: () => string; stroke: () => string; fill: () => string; text: () => string };
        type Group = { getChildren: () => Node[] };
        const K = (window as unknown as { Konva: { stages: { find: (s: string) => Group[] }[] } }).Konva;
        return K.stages.flatMap((st) => st.find('.unresolved-part')).map((g) => {
          const kids = g.getChildren();
          const of = (c: string) => kids.filter((k) => k.getClassName() === c);
          return {
            box: of('Rect').map((r) => r.fill()).join(),
            cross: of('Line').map((l) => l.stroke()).join(),
            label: of('Text').map((t) => `${t.text()}|${t.fill()}`).join(),
          };
        });
      });
    await expect.poll(async () => (await placeholders()).length).toBe(unknown);
    const looks = await placeholders();
    for (const l of looks) {
      expect(l.box).toBe('rgba(0,0,0,0)');
      expect(l.cross).toBe('#ff0000,#ff0000');
      expect(l.label).toMatch(/\|#000000$/);
    }
    expect(looks.map((l) => l.label)).toContain('NO_SUCH_PART.1|#000000');
  });
});

test.describe('brick stacking', () => {
  test('bricks draw in the sheet\'s order, whatever their altitude (like BlueBrick)', async ({ page }) => {
    // The first brick in the file, lifted to altitude 5: BlueBrick still draws it
    // first (an altitude edit re-sorts the sheet; loading a file doesn't).
    const bbm = FORDYCE_BBM.replace(/(<Brick id="5">[\s\S]*?<Altitude>)0(<\/Altitude>)/, '$15$2');
    const id = await createLayout(page, bbm);
    await openEditor(page, id);
    const position = () =>
      page.evaluate(() => {
        type Node = { name: () => string; getParent: () => { getChildren: () => Node[] } };
        const K = (window as unknown as { Konva: { stages: { findOne: (s: string) => Node | undefined }[] } }).Konva;
        const g = K.stages.map((st) => st.findOne('.brick-5')).find(Boolean);
        if (!g) return null;
        const siblings = g.getParent().getChildren();
        return { index: siblings.indexOf(g), last: siblings.length - 1 };
      });
    await expect.poll(async () => (await position())?.index).not.toBeUndefined();
    const p = (await position())!;
    expect(p.index).toBeLessThan(p.last);

    // Bring to Front puts the clicked part on top of its sheet (the drawing order is the sheet's order).
    const orders = () => page.evaluate(() => {
      type Node = { name: () => string; getChildren: () => Node[]; getParent: () => Node };
      const K = (window as unknown as { Konva: { stages: { find: (f: (n: Node) => boolean) => Node[] }[] } }).Konva;
      const parents = new Set<Node>();
      for (const st of K.stages) for (const n of st.find((x) => /^brick-/.test(x.name()))) parents.add(n.getParent());
      return [...parents].map((pa) => pa.getChildren().map((n) => n.name()).filter((x) => x.startsWith('brick-')));
    });
    const was = await orders();
    // Over brick 5: whichever part is on top there gets picked.
    const mid = await page.evaluate(() => {
      type N = { getClientRect: () => { x: number; y: number; width: number; height: number }; getStage: () => { container: () => HTMLElement } };
      const K = (window as unknown as { Konva: { stages: { findOne: (s: string) => N | undefined }[] } }).Konva;
      const g = K.stages.map((st) => st.findOne('.brick-5')).find(Boolean)!;
      const r = g.getClientRect();
      const c = g.getStage().container().getBoundingClientRect();
      return { x: c.left + r.x + r.width / 2, y: c.top + r.y + r.height / 2 };
    });
    await page.mouse.click(mid.x, mid.y);
    await expect(page.locator('footer')).toContainText('selected: 1');
    await page.keyboard.press('ControlOrMeta+Shift+BracketRight');
    await expect.poll(async () => {
      const now = await orders();
      return was.some((o, i) => now[i] && now[i]!.at(-1) !== o.at(-1) && now[i]!.length === o.length);
    }).toBe(true);
  });
});

test.describe('grid cell indices', () => {
  test('columns and rows are labelled along the origin cell only, one axis per label', async ({ page }) => {
    // Fordyce's grid layer shows cell indices (letters across, numbers down).
    const id = await createLayout(page, FORDYCE_BBM);
    await openEditor(page, id);
    const labels = () =>
      page.evaluate(() => {
        type Node = { text: () => string; find: (s: string) => Node[] };
        const K = (window as unknown as { Konva: { stages: { find: (s: string) => Node[] }[] } }).Konva;
        return K.stages.flatMap((st) => st.find('.cell-index')).flatMap((g) => g.find('Text')).map((t) => t.text());
      });
    await expect.poll(async () => (await labels()).length).toBeGreaterThan(0);
    const texts = await labels();
    // Never the old "A1" per-cell labels: letters or numbers, never both.
    expect(texts.every((t) => /^[A-Z]+$/.test(t) || /^\d+$/.test(t))).toBe(true);
    expect(texts.some((t) => /^[A-Z]+$/.test(t))).toBe(true);
    expect(texts.some((t) => /^\d+$/.test(t))).toBe(true);
    await shot(page, 'grid-cell-index.png');
  });
});

test.describe('venue obstacles', () => {
  test('an obstacle needs a venue outline first; with one, the tool says how to draw', async ({ page }) => {
    const id = await createLayout(page);
    await openEditor(page, id);
    const footer = page.locator('footer');
    const drawObstacle = async () => {
      await mapMenu(page, 'Venue', 'Add obstacle…');
    };

    await drawObstacle();
    await expect(page.getByTestId('notice')).toContainText('Draw the venue’s outline first');
    await expect(footer).toContainText('Tool: Select');

    // Draw an outline, then the obstacle tool is allowed.
    await mapMenu(page, 'Venue', 'Draw outline…');
    await expect(footer).toContainText('Click points to outline the venue.');
    const box = (await page.locator('.konvajs-content').first().boundingBox())!;
    for (const [dx, dy] of [[-60, -60], [60, -60], [0, 60]] as const) {
      await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
    }
    await page.keyboard.press('Enter');
    await expect(footer).toContainText('Venue: OK');

    await drawObstacle();
    await expect(footer).toContainText('Click points to outline an obstacle.');
    await expect(footer).toContainText('Tool: Obstacle');
  });
});

test.describe('drawing a ruler', () => {
  test('the preview reads studs and mm, and the ruler lands with desktop defaults on a Rulers layer', async ({ page }) => {
    const id = await createLayout(page);
    await openEditor(page, id);
    await page.getByRole('button', { name: 'Measure', exact: true }).click();
    const box = (await page.locator('.konvajs-content').first().boundingBox())!;
    const x0 = box.x + 200;
    const y0 = box.y + 200;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    // 160 px at zoom 1 = 20 studs.
    await page.mouse.move(x0 + 160, y0, { steps: 8 });
    const previewText = () =>
      page.evaluate(() => {
        type Node = { text: () => string };
        const K = (window as unknown as { Konva: { stages: { find: (s: string) => Node[] }[] } }).Konva;
        return K.stages.flatMap((st) => st.find('Text')).map((t) => t.text()).filter((t) => t.includes('studs ('));
      });
    await expect.poll(previewText).toContain('20.0 studs (160 mm)');
    await page.mouse.up();

    const xml = async () => (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
    await expect.poll(async () => /<LinearRuler/.test(await xml())).toBe(true);
    const x = await xml();
    expect(x).toMatch(/<Layer type="ruler" id="[^"]+">\s*<Name>Rulers<\/Name>/);
    const ruler = x.slice(x.indexOf('<LinearRuler'), x.indexOf('</LinearRuler>'));
    expect(ruler).toMatch(/<LineThickness>1<\/LineThickness>/);
    expect(ruler).toMatch(/<Color>\s*<IsKnownColor>true<\/IsKnownColor>\s*<Name>Black<\/Name>/);
  });
});

test.describe('fit to view', () => {
  test('fits text as well as bricks, centred, with desktop\'s 50 px margin', async ({ page }) => {
    // A map whose only content is a text cell far from the origin.
    const withText = FORDYCE_BBM
      .replace(/<Layer type="brick"[\s\S]*?<\/Layer>/g, '')
      .replace(/<Layer type="ruler"[\s\S]*?<\/Layer>/g, '')
      .replace(/(<Layer type="text" id="\d+">[\s\S]*?<TextCells>)[\s\S]*?(<\/TextCells>)/, (_m, a: string, b: string) =>
        `${a}<TextCell><DisplayArea><X>2000</X><Y>1000</Y><Width>40</Width><Height>10</Height></DisplayArea>` +
        '<Text>Far away</Text><Orientation>0</Orientation><FontColor><IsKnownColor>true</IsKnownColor><Name>Black</Name></FontColor>' +
        `<Font><FontFamily>Arial</FontFamily><Size>12</Size><Style>Regular</Style></Font><TextAlignment>Center</TextAlignment></TextCell>${b}`);
    const id = await createLayout(page, withText);
    await openEditor(page, id);
    await mapMenu(page, 'View', 'Fit to view');
    const view = await page.evaluate(() => {
      type Stage = { x: () => number; y: () => number; scaleX: () => number; width: () => number; height: () => number };
      const K = (window as unknown as { Konva: { stages: Stage[] } }).Konva;
      const st = K.stages[0]!;
      return { x: st.x(), y: st.y(), z: st.scaleX(), w: st.width(), h: st.height() };
    });
    // The text's centre, (2020, 1005) studs, is on the view centre.
    expect((2020 * 8 * view.z + view.x) - view.w / 2).toBeCloseTo(0, 0);
    expect((1005 * 8 * view.z + view.y) - view.h / 2).toBeCloseTo(0, 0);
    // The 320 x 80 px box plus 100 px fits the width.
    expect(view.z).toBeCloseTo((view.w - 4) / 420, 2);
  });
});

test.describe('selection while snapping', () => {
  test('the dragged brick\'s outline turns green while a connection snap is live', async ({ page }) => {
    const id = await createLayout(page);
    await openEditor(page, id);
    await page.getByPlaceholder('Search parts (name or number)').fill('2865.8');
    const tile = page.locator('aside li button[draggable="true"]').filter({ has: page.locator('img') }).first();
    const box = (await page.locator('.konvajs-content').first().boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const bricks = async () => ((await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text()).match(/<Brick id=/g) ?? []).length;
    // One straight, dragged 40 studs left, then a second at the view
    // centre: their facing ends are 24 studs apart, too far to snap.
    await tile.dblclick();
    await expect.poll(bricks).toBe(1);
    // Placing the first brick auto-fits the view; zoom out so the drags stay
    // on the canvas (a drop outside it deletes), and work in studs.
    const zoom = () =>
      page.evaluate(() => (window as unknown as { Konva: { stages: { scaleX: () => number }[] } }).Konva.stages[0]!.scaleX());
    await page.waitForTimeout(300);
    for (let i = 0; i < 8; i++) await page.keyboard.press('Control+-');
    await page.waitForTimeout(300);
    const studPx = 8 * (await zoom());
    expect(40 * studPx).toBeLessThan(box.width / 2 - 20);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 40 * studPx, cy, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await tile.dblclick();
    await expect.poll(bricks).toBe(2);

    // The halos the selection overlay drew last (and its copy on the drag layer, mid-drag).
    const haloStrokes = () =>
      page.evaluate(() => {
        type Node = { attrs: { drawn?: { halos: number; stroke: string | null } } };
        const K = (window as unknown as { Konva: { stages: { find: (s: string) => Node[] }[] } }).Konva;
        return K.stages
          .flatMap((st) => st.find('.selection-overlay'))
          .filter((o) => (o.attrs.drawn?.halos ?? 0) > 0)
          .map((o) => o.attrs.drawn!.stroke);
      });
    // The new piece is selected; drag it left until its free end is half a
    // stud from the other's.
    await expect.poll(haloStrokes).toEqual(['#FFD700']);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 23.5 * studPx, cy, { steps: 16 });
    await expect.poll(haloStrokes).toEqual(['rgb(80,255,120)']);
    await page.mouse.up();
    await expect.poll(haloStrokes).toEqual(['#FFD700']);
  });
});

test.describe('context menu paste', () => {
  test('Paste and Add Text Here are for empty space; Paste only once something is copied', async ({ page }) => {
    const id = await createLayout(page);
    await openEditor(page, id);
    await page.getByPlaceholder('Search parts (name or number)').fill('2865.8');
    await page.locator('aside li button[draggable="true"]').filter({ has: page.locator('img') }).first().dblclick();
    await expect(page.locator('footer')).toContainText('selected: 1');
    const box = (await page.locator('.konvajs-content').first().boundingBox())!;
    const menu = page.locator('[data-ctx-menu]');
    const entries = async () => (await menu.locator('button').allInnerTexts()).map((t) => t.trim());

    // On the selected brick: its actions, no Paste or Add Text Here.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await expect(menu).toBeVisible();
    expect(await entries()).not.toContain('Paste');
    expect(await entries()).not.toContain('Add Text Here…');
    await page.keyboard.press('Escape');

    // Empty space, nothing copied yet: Add Text Here but no Paste.
    await page.keyboard.press('Escape'); // deselect
    await page.mouse.click(box.x + 20, box.y + 20, { button: 'right' });
    await expect(menu).toBeVisible();
    expect(await entries()).toContain('Add Text Here…');
    expect(await entries()).not.toContain('Paste');
    await page.keyboard.press('Escape');

    // Copy the brick, then empty space offers Paste.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator('footer')).toContainText('selected: 1');
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Escape');
    await page.mouse.click(box.x + 20, box.y + 20, { button: 'right' });
    await expect.poll(entries).toContain('Paste');
  });
});

test.describe('part list export', () => {
  test('CSV and HTML in vanilla BlueBrick\'s layout, with part pictures in the HTML', async ({ page }) => {
    test.slow();
    const id = await createLayout(page, FORDYCE_BBM);
    await openEditor(page, id);
    const openDialog = async () => {
      await mapMenu(page, 'Download & export', 'Export part list…');
      return page.getByRole('dialog', { name: 'Export Part List' });
    };

    let dialog = await openDialog();
    await dialog.getByLabel('CSV').check();
    let dl = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    let file = await dl;
    expect(file.suggestedFilename()).toBe('Parity Test.csv');
    const csv = readFileSync(await file.path(), 'utf-8').split('\n');
    expect(csv[0]).toBe('Part,In Use,Color,Description,Budgeted,Missing,Part Usage %');
    expect(csv.find((l) => l.startsWith('3857,'))).toMatch(/^3857,72,/);
    expect(csv.find((l) => l.startsWith('Total,'))).toMatch(/^Total,\d+,,,N\/A,N\/A,N\/A$/);
    await shot(page, 'part-list.png');

    dialog = await openDialog();
    await expect(dialog.getByLabel('HTML (with pictures)')).toBeChecked();
    dl = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    file = await dl;
    expect(file.suggestedFilename()).toBe('Parity Test.html');
    const html = readFileSync(await file.path(), 'utf-8');
    expect(html).toContain('<h2 class="title">Part List for file &quot;Parity Test.bbm&quot;</h2>');
    expect(html).toMatch(/<img src="data:image\/png;base64,[A-Za-z0-9+/=]+"><br\/>3857/);
  });
});

test.describe('new layout template', () => {
  test('a layout marked as the template is where new layouts start', async ({ page }) => {
    const templateId = await createLayout(page, FORDYCE_BBM);
    const rename = await page.request.patch(`/api/layouts/${templateId}`, { data: { title: `Club base ${Date.now()}` } });
    expect(rename.ok()).toBe(true);
    await page.goto('/');
    const row = page.locator('li', { has: page.getByRole('link', { name: 'Open' }) }).filter({ hasText: 'Club base' }).first();
    await row.getByRole('button', { name: /^More for Club base/ }).click();
    await row.getByLabel('Template for new layouts').check();

    await page.getByRole('button', { name: 'New layout' }).click();
    const startFrom = page.getByLabel(/Start from template “Club base/);
    await expect(startFrom).toBeChecked();
    await page.getByPlaceholder('Untitled Layout').fill('From template');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/editor\/[^/]+$/, { timeout: 15000 });
    const newId = page.url().split('/editor/')[1]!;
    const bbm = await (await page.request.get(`/api/layouts/${newId}/export.bbm`)).text();
    expect(countPart(bbm, '3857.0')).toBe(72);

    // Unticked, a new layout starts empty.
    await page.goto('/');
    await page.getByRole('button', { name: 'New layout' }).click();
    await page.getByLabel(/Start from template/).uncheck();
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page).toHaveURL(/\/editor\/[^/]+$/, { timeout: 15000 });
    const emptyId = page.url().split('/editor/')[1]!;
    expect(countPart(await (await page.request.get(`/api/layouts/${emptyId}/export.bbm`)).text(), '3857.0')).toBe(0);

    // Clean up the preference for the other tests.
    await page.evaluate(() => localStorage.removeItem('cld:newLayoutTemplate'));
  });
});

test.describe('grid origin drag', () => {
  test('with the grid layer active, dragging empty space moves the cell-index origin by whole cells', async ({ page }) => {
    test.slow();
    const id = await createLayout(page, FORDYCE_BBM);
    await openEditor(page, id);
    const corner = async () => {
      const xml = await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
      const m = /<CellIndexCorner>\s*<X>(-?\d+)<\/X>\s*<Y>(-?\d+)<\/Y>/.exec(xml)!;
      return { x: Number(m[1]), y: Number(m[2]) };
    };
    const before = await corner();

    // Make the grid layer (the file's "Layer 1", shown as "Sheet 1") the active layer.
    await page.locator('aside').getByText('Sheet 1', { exact: true }).click();
    await expect(page.locator('footer')).toContainText('Sheet: Sheet 1');

    const z = await page.evaluate(() => (window as unknown as { Konva: { stages: { scaleX: () => number }[] } }).Konva.stages[0]!.scaleX());
    const cellStuds = Number(/<GridSizeInStud>(\d+)<\/GridSizeInStud>/.exec(FORDYCE_BBM)![1]);
    const cellPx = cellStuds * 8 * z;
    const box = (await page.locator('.konvajs-content').first().boundingBox())!;
    // Empty space just inside the top-left of the view.
    const x0 = box.x + 12;
    const y0 = box.y + 12;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 3 * cellPx, y0 + 2 * cellPx, { steps: 12 });
    await page.mouse.up();
    await expect.poll(corner).toEqual({ x: before.x + 3, y: before.y + 2 });
    await expect(page.locator('footer')).not.toContainText('selected:');

    // One undo step.
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(corner).toEqual(before);

    // Right-click cancels, without opening the context menu.
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 2 * cellPx, y0, { steps: 8 });
    await page.mouse.click(x0 + 2 * cellPx, y0, { button: 'right' });
    await page.mouse.up();
    await page.waitForTimeout(500);
    expect(await corner()).toEqual(before);
    await expect(page.locator('[data-ctx-menu]')).toHaveCount(0);
  });
});

test.describe('flex track', () => {
  test('a selected flex chain bends like vanilla BlueBrick: by its end\'s handle (flex-a) or a double-click-drag (flex-c)', async ({ page }) => {
    test.slow();
    const fixtures = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures/oracle');
    const oracle = (name: string) => readFileSync(join(fixtures, name), 'utf-8');
    const id = await createLayout(page, oracle('flex-in.bbm'));
    await openEditor(page, id);
    const selectAll = async () => {
      await page.keyboard.press('Control+a');
      await expect(page.locator('footer')).toContainText(/selected: \d+/);
    };
    await selectAll();

    const toScreen = async (sx: number, sy: number) => {
      const t = await page.evaluate(() => {
        const st = (window as unknown as { Konva: { stages: { x: () => number; y: () => number; scaleX: () => number }[] } }).Konva.stages[0]!;
        return { x: st.x(), y: st.y(), z: st.scaleX() };
      });
      const box = (await page.locator('.konvajs-content').first().boundingBox())!;
      return { x: box.x + t.x + sx * 8 * t.z, y: box.y + t.y + sy * 8 * t.z };
    };
    const poses = (xml: string) =>
      new Map(
        [...xml.matchAll(/<Brick id="([^"]+)">[\s\S]*?<X>([^<]+)<\/X>\s*<Y>([^<]+)<\/Y>\s*<Width>([^<]+)<\/Width>\s*<Height>([^<]+)<\/Height>[\s\S]*?<Orientation>([^<]+)<\/Orientation>/g)].map(
          (m) => [m[1]!, { cx: +m[2]! + +m[4]! / 2, cy: +m[3]! + +m[5]! / 2, o: +m[6]! }],
        ),
      );
    const exported = async () => (await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text());
    /** The worst difference from vanilla's result, studs (and tenths of a degree). */
    const offVanilla = (name: string) => async () => {
      const vanilla = poses(oracle(name));
      const ours = poses(await exported());
      let worst = 0;
      for (const [bid, v] of vanilla) {
        const o = ours.get(bid);
        if (!o) return Infinity;
        worst = Math.max(worst, Math.abs(o.cx - v.cx), Math.abs(o.cy - v.cy), Math.abs(((o.o - v.o) % 360 + 540) % 360 - 180) / 10);
      }
      return worst;
    };
    const undoToStraight = async () => {
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect.poll(async () => (await offVanilla('flex-in.bbm')())).toBeLessThan(0.05);
    };

    // The free flex end at (68, 40) studs carries a bend handle: dragging it
    // to (62, 30) in one go is vanilla's flex-a (a double-click-drag there).
    const end = await toScreen(68, 40);
    const to = await toScreen(62, 30);
    await page.mouse.move(end.x, end.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 1 }); // the solve depends on the path (flex-b)
    await page.mouse.up();
    await expect(page.locator('footer')).toContainText('Bend flex track');
    await expect.poll(offVanilla('flex-a.bbm')).toBeLessThan(0.05);
    // One undo step puts it all back.
    await undoToStraight();

    // Off the handles, a double-click whose second press drags grabs that
    // piece: vanilla's flex-c grabs the middle piece 5048093428964172125 at
    // (61.25, 40) and drags it to (61, 35). Where it overlaps the next piece
    // that one is on top, so grab it a stud left, clear of it: the same move.
    await selectAll();
    const mid = await toScreen(60.25, 40);
    const midTo = await toScreen(60, 35);
    await page.mouse.click(mid.x, mid.y);
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.down();
    await page.mouse.move(midTo.x, midTo.y, { steps: 1 });
    await page.mouse.up();
    await expect(page.locator('footer')).toContainText('Flex move');
    await expect.poll(offVanilla('flex-c.bbm')).toBeLessThan(0.05);
    await undoToStraight();

    // A double-click without moving opens the brick's properties as usual.
    await page.mouse.dblclick(mid.x, mid.y);
    await expect(page.getByRole('dialog')).toBeVisible();
  });
});

test.describe('rotating text (BlueBrick RotateText)', () => {
  test('right-click a text, Rotate CW turns it; a second window sees it live and turns it on', async ({ page, browser }) => {
    const id = await createLayout(page);
    await openEditor(page, id);
    const box = (await page.locator('.konvajs-content').first().boundingBox())!;
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    // T puts the text at the view centre.
    await page.keyboard.press('t');
    const dialog = page.getByRole('dialog');
    await dialog.locator('input[type="text"], textarea').first().fill('Yard');
    await dialog.getByRole('button', { name: 'OK' }).click();
    const bbm = () => page.request.get(`/api/layouts/${id}/export.bbm`).then((r) => r.text());
    const cell = async () => {
      const xml = await bbm();
      return xml.includes('<TextCell>') ? xml.slice(xml.indexOf('<TextCell>'), xml.indexOf('</TextCell>')) : '';
    };
    const num = (xml: string, tag: string) => Number(new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml)?.[1]);
    await expect.poll(async () => (await cell()) !== '').toBe(true);
    const before = await cell();

    // The other window, open on the same layout.
    const other = await browser.newContext();
    const page2 = await other.newPage();
    await signIn(page2, EMAIL, 'Parity Tester');
    await openEditor(page2, id);

    await page.mouse.click(centre.x, centre.y, { button: 'right' });
    await page.locator('button', { hasText: /^Turn right$/ }).click();
    await expect.poll(async () => num(await cell(), 'Orientation')).toBe(90);
    const after = await cell();
    // It turned in place: same centre, the box stood upright.
    expect(num(after, 'X') + num(after, 'Width') / 2).toBeCloseTo(num(before, 'X') + num(before, 'Width') / 2, 3);
    expect(num(after, 'Width')).toBeCloseTo(num(before, 'Height'), 3);

    // The second window turns it again: from 90, so it had the first turn live.
    // Right-click the text where it's drawn (its view fits the grid's
    // letters too, so it isn't at the centre).
    const box2 = (await page2.locator('.konvajs-content').first().boundingBox())!;
    const yard = () =>
      page2.evaluate(() => {
        type N = { className: string; text?: () => string; getClientRect: () => { x: number; y: number; width: number; height: number } };
        const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
        const n = st?.find((x) => x.className === 'Text' && x.text?.() === 'Yard')[0];
        if (!n) return null;
        const r = n.getClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
    await expect.poll(yard).not.toBeNull();
    const at = (await yard())!;
    await page2.mouse.click(box2.x + at.x, box2.y + at.y, { button: 'right' });
    await page2.locator('button', { hasText: /^Turn right$/ }).click();
    await expect.poll(async () => num(await cell(), 'Orientation')).toBe(180);
    await other.close();
  });
});

test.describe('rotation pivot (BlueBrick RotateItems, RotateBrick)', () => {
  const ORACLE = (name: string) =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures/oracle', name), 'utf-8');
  const STRAIGHT = '186617953428535140';
  /** Each part's box and orientation, by id, from a .bbm. */
  const parts = (xml: string) => {
    const out = new Map<string, number[]>();
    for (const m of xml.matchAll(/<Brick id="(\d+)">\s*<DisplayArea>\s*<X>([^<]+)<\/X>\s*<Y>([^<]+)<\/Y>\s*<Width>([^<]+)<\/Width>\s*<Height>([^<]+)<\/Height>[\s\S]*?<Orientation>([^<]+)<\/Orientation>/g))
      out.set(m[1]!, [2, 3, 4, 5, 6].map((i) => Number(m[i])));
    return out;
  };
  const toScreen = (page: Page, s: { x: number; y: number }) =>
    page.evaluate((p) => {
      const st = (window as unknown as {
        Konva: { stages: { container: () => HTMLElement; getAbsoluteTransform: () => { point: (q: { x: number; y: number }) => { x: number; y: number } } }[] };
      }).Konva.stages[0]!;
      const box = st.container().getBoundingClientRect();
      const a = st.getAbsoluteTransform().point({ x: p.x * 8, y: p.y * 8 });
      return { x: box.left + a.x, y: box.top + a.y };
    }, s);

  test('a joined straight flips round its join; a second window turns everything about the box, like vanilla', async ({ page, browser }) => {
    const id = await createLayout(page, ORACLE('flex-in.bbm'));
    await openEditor(page, id);
    const bbm = () => page.request.get(`/api/layouts/${id}/export.bbm`).then((r) => r.text());
    const near = (got: Map<string, number[]>, want: Map<string, number[]>, only?: string) => {
      for (const [pid, w] of want) {
        if (only && pid !== only) continue;
        const g = got.get(pid)!;
        for (let i = 0; i < 4; i++) if (Math.abs(g[i]! - w[i]!) > 0.01) return false;
        if (Math.abs((((g[4]! - w[4]!) % 360) + 360) % 360) > 0.01 && Math.abs((((g[4]! - w[4]!) % 360) + 360) % 360 - 360) > 0.01) return false;
      }
      return true;
    };

    // Right-click the straight (17 x 8 at (31.5, 36)), Rotate CW: it stays
    // joined to the flex end, so it flips in place (vanilla rot-one-ccw).
    const at = await toScreen(page, { x: 40, y: 37.35 }); // on a rail
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.locator('button', { hasText: /^Turn right$/ }).click();
    const oneTurn = parts(ORACLE('rot-one-ccw.bbm'));
    await expect.poll(async () => near(parts(await bbm()), oneTurn, STRAIGHT)).toBe(true);
    // Back as it was, for the second window.
    await page.keyboard.press('Control+z');
    await expect.poll(async () => near(parts(await bbm()), parts(ORACLE('flex-in.bbm')))).toBe(true);

    // A second window picks everything and turns it: about the box centre.
    const other = await browser.newContext();
    const page2 = await other.newPage();
    await signIn(page2, EMAIL, 'Parity Tester');
    await openEditor(page2, id);
    const box2 = (await page2.locator('.konvajs-content').first().boundingBox())!;
    await page2.mouse.click(box2.x + 5, box2.y + box2.height - 5);
    await page2.keyboard.press('Control+a');
    await page2.keyboard.press('Shift+R'); // Shift+R turns by +step, as Rotate CW
    await expect.poll(async () => near(parts(await bbm()), parts(ORACLE('rot-all1.bbm')))).toBe(true);
    await other.close();
  });
});

test.describe('scaling a ruler (BlueBrick ScaleRuler)', () => {
  /** The scale handle's page position, or null when it isn't shown. */
  const scaleHandle = (page: Page) =>
    page.evaluate(() => {
      type N = { getAbsolutePosition: () => { x: number; y: number } };
      const st = (window as unknown as { Konva: { stages: { container: () => HTMLElement; find: (s: string) => N[] }[] } }).Konva.stages[0]!;
      const h = st.find('.ruler-scale')[0];
      if (!h) return null;
      const box = st.container().getBoundingClientRect();
      const p = h.getAbsolutePosition();
      return { x: box.left + p.x, y: box.top + p.y };
    });

  test("drag a circle's rim handle to change its radius; a second window sees it live and drags it on", async ({ page, browser }) => {
    const id = await createLayout(page);
    await openEditor(page, id);
    const box = (await page.locator('.konvajs-content').first().boundingBox())!;
    const c = { x: box.x + 300, y: box.y + 250 };
    // Draw a circle of 10 studs (80 px at zoom 1).
    await page.getByRole('button', { name: 'Circle', exact: true }).click();
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 80, c.y, { steps: 8 });
    await page.mouse.up();
    const xml = async () => (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
    const radius = async () => Number(/<CircularRuler[\s\S]*?<Radius>([^<]+)<\/Radius>/.exec(await xml())?.[1]);
    await expect.poll(radius).toBeCloseTo(10, 1);

    // Pick it (click its rim), then drag the handle on the rim 5 studs out.
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await page.mouse.click(c.x, c.y - 80);
    await expect.poll(() => scaleHandle(page)).not.toBeNull();
    const h = (await scaleHandle(page))!;
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    await page.mouse.move(h.x + 40, h.y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(radius).toBeCloseTo(15, 1);

    // The second window picks the circle and drags it on: from 15, so it had the first drag live.
    const other = await browser.newContext();
    const page2 = await other.newPage();
    await signIn(page2, EMAIL, 'Parity Tester');
    await openEditor(page2, id);
    // Its view may differ: work in its own transform, from the circle's centre.
    const centre = /<CircularRuler[\s\S]*?<Center>\s*<X>([^<]+)<\/X>\s*<Y>([^<]+)<\/Y>/.exec(await xml())!;
    const cStuds = { x: Number(centre[1]), y: Number(centre[2]) };
    const onPage2 = (sx: number, sy: number) =>
      page2.evaluate((q) => {
        const st = (window as unknown as {
          Konva: { stages: { container: () => HTMLElement; getAbsoluteTransform: () => { point: (q: { x: number; y: number }) => { x: number; y: number } } }[] };
        }).Konva.stages[0]!;
        const b = st.container().getBoundingClientRect();
        const a = st.getAbsoluteTransform().point({ x: q.x * 8, y: q.y * 8 });
        return { x: b.left + a.x, y: b.top + a.y };
      }, { x: sx, y: sy });
    const rim = await onPage2(cStuds.x, cStuds.y - 15);
    await page2.mouse.click(rim.x, rim.y);
    await expect.poll(() => scaleHandle(page2)).not.toBeNull();
    const h2 = (await scaleHandle(page2))!;
    // The handle is on the 15-stud rim: the first window's drag arrived.
    const want = await onPage2(cStuds.x + 15, cStuds.y);
    expect(Math.abs(h2.x - want.x)).toBeLessThan(2);
    const to = await onPage2(cStuds.x + 20, cStuds.y);
    await page2.mouse.move(h2.x, h2.y);
    await page2.mouse.down();
    await page2.mouse.move(to.x, to.y, { steps: 8 });
    await page2.mouse.up();
    await expect.poll(radius).toBeCloseTo(20, 0);
    await other.close();
  });
});

test.describe('Use as Model (BlueBrick)', () => {
  test("right-click a part, Use as Model: the parts list finds and picks it", async ({ page }) => {
    const flexIn = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures/oracle/flex-in.bbm'),
      'utf-8',
    );
    const id = await createLayout(page, flexIn);
    await openEditor(page, id);
    // The straight 2865.8 (17 x 8 at (31.5, 36)), on a rail.
    const at = await page.evaluate((p) => {
      const st = (window as unknown as {
        Konva: { stages: { container: () => HTMLElement; getAbsoluteTransform: () => { point: (q: { x: number; y: number }) => { x: number; y: number } } }[] };
      }).Konva.stages[0]!;
      const box = st.container().getBoundingClientRect();
      const a = st.getAbsoluteTransform().point({ x: p.x * 8, y: p.y * 8 });
      return { x: box.left + a.x, y: box.top + a.y };
    }, { x: 40, y: 37.35 });
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.locator('button', { hasText: /^Use as Model$/ }).click();
    await expect(page.getByPlaceholder('Search parts (name or number)')).toHaveValue(/^2865\.8$/i);
    const tile = page.locator('[data-part-key]', { hasText: /./ }).and(page.locator('[aria-pressed="true"]'));
    await expect(tile).toHaveCount(1);
    await expect(tile).toHaveAttribute('data-part-key', /^2865\.8$/i);
    await expect(tile).toBeInViewport();
  });
});

test.describe('moving an area sheet (BlueBrick MoveArea)', () => {
  test('paint a cell; a second window Ctrl+drags the whole sheet by cells', async ({ page, browser }) => {
    const id = await createLayout(page);
    await openEditor(page, id);
    const xml = async () => (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
    const cells = async () => [...(await xml()).matchAll(/<Area>\s*<x>(-?\d+)<\/x>\s*<y>(-?\d+)<\/y>/g)].map((m) => `${m[1]},${m[2]}`);
    const toScreen = (p: Page, s: { x: number; y: number }) =>
      p.evaluate((q) => {
        const st = (window as unknown as {
          Konva: { stages: { container: () => HTMLElement; getAbsoluteTransform: () => { point: (r: { x: number; y: number }) => { x: number; y: number } } }[] };
        }).Konva.stages[0]!;
        const box = st.container().getBoundingClientRect();
        const a = st.getAbsoluteTransform().point({ x: q.x * 8, y: q.y * 8 });
        return { x: box.left + a.x, y: box.top + a.y };
      }, s);

    // Paint the cell under (4, 4) studs: cell (0, 0) at the default size.
    await page.getByRole('button', { name: 'Paint', exact: true }).click();
    const at = await toScreen(page, { x: 4, y: 4 });
    await page.mouse.click(at.x, at.y);
    await expect.poll(cells).toEqual(['0,0']);
    const size = Number(/<AreaCellSize>(\d+)<\/AreaCellSize>/.exec(await xml())![1]);

    // The second window, Paint picked, Ctrl+drags one cell right and one down.
    const other = await browser.newContext();
    const page2 = await other.newPage();
    await signIn(page2, EMAIL, 'Parity Tester');
    await openEditor(page2, id);
    await page2.getByRole('button', { name: 'Paint', exact: true }).click();
    const from = await toScreen(page2, { x: 4, y: 4 });
    const to = await toScreen(page2, { x: 4 + size, y: 4 + size });
    const canvas = (await page2.locator('.konvajs-content').first().boundingBox())!;
    expect(to.x).toBeLessThan(canvas.x + canvas.width); // the drag stays on the map
    expect(to.y).toBeLessThan(canvas.y + canvas.height);
    await page2.keyboard.down('Control');
    await page2.mouse.move(from.x, from.y);
    await page2.mouse.down();
    await page2.mouse.move(to.x, to.y, { steps: 10 });
    await page2.mouse.up();
    await page2.keyboard.up('Control');
    // Moved, not painted: still one cell.
    await expect.poll(cells).toEqual(['1,1']);
    await other.close();
  });
});

test.describe('detaching a ruler (BlueBrick Detach)', () => {
  const FLEX_IN = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures/oracle/flex-in.bbm'),
    'utf-8',
  );
  const toScreen = (page: Page, s: { x: number; y: number }) =>
    page.evaluate((p) => {
      const st = (window as unknown as {
        Konva: { stages: { container: () => HTMLElement; getAbsoluteTransform: () => { point: (q: { x: number; y: number }) => { x: number; y: number } } }[] };
      }).Konva.stages[0]!;
      const box = st.container().getBoundingClientRect();
      const a = st.getAbsoluteTransform().point({ x: p.x * 8, y: p.y * 8 });
      return { x: box.left + a.x, y: box.top + a.y };
    }, s);

  test('attach a ruler end to a part from the menu; a second window detaches it from the ruler\'s menu', async ({ page, browser }) => {
    const id = await createLayout(page, FLEX_IN);
    await openEditor(page, id);
    const xml = async () => (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
    // The first end's part; '' when free (written <AttachedBrick1 /> or 0).
    const attached1 = async () => {
      const ruler = /<LinearRuler[\s\S]*?<\/LinearRuler>/.exec(await xml())?.[0] ?? '';
      const id = /<AttachedBrick1>([^<]*)<\/AttachedBrick1>/.exec(ruler)?.[1] ?? '';
      return id === '0' ? '' : id;
    };

    // Draw a ruler just above the track, from (33, 30) to (45, 30) studs.
    await page.getByRole('button', { name: 'Measure', exact: true }).click();
    const a = await toScreen(page, { x: 33, y: 30 });
    const b = await toScreen(page, { x: 45, y: 30 });
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => /<LinearRuler/.test(await xml())).toBe(true);

    // Pick it, then right-click the straight: attach its first end there.
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    const mid = await toScreen(page, { x: 34.5, y: 30 }); // on the line, not its label
    await page.mouse.click(mid.x, mid.y);
    await expect(page.getByText(/selected: 1/)).toBeVisible();
    const rail = await toScreen(page, { x: 40, y: 37.35 });
    await page.mouse.click(rail.x, rail.y, { button: 'right' });
    await expect(page.locator('button', { hasText: /^Detach/ })).toHaveCount(0);
    await page.locator('button', { hasText: /^Attach Endpoint 1 to this brick$/ }).click();
    await expect.poll(attached1).toBe('186617953428535140');

    // The second window right-clicks the ruler, which now runs from the
    // straight's centre (40, 40) to (45, 30), and detaches that end.
    const other = await browser.newContext();
    const page2 = await other.newPage();
    await signIn(page2, EMAIL, 'Parity Tester');
    await openEditor(page2, id);
    const onLine = await toScreen(page2, { x: 43, y: 34 });
    await page2.mouse.click(onLine.x, onLine.y, { button: 'right' });
    await expect(page2.locator('button', { hasText: /^Detach Endpoint 2$/ })).toHaveCount(0);
    await page2.locator('button', { hasText: /^Detach Endpoint 1$/ }).click();
    await expect.poll(attached1).toBe('');
    await other.close();
  });
});

test.describe('canvas layers', () => {
  // Konva warned "Recommended maximum number of layers is 3-5" on every
  // editor load with 6; the module outlines now share the drag layer.
  test('the editor builds at most 5 Konva layers, and Konva says nothing about it', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (/maximum number of layers/i.test(m.text())) warnings.push(m.text());
    });
    const id = await createLayout(page);
    await openEditor(page, id);
    const layers = await page.evaluate(() => {
      const st = (window as unknown as { Konva: { stages: { getLayers: () => { name: () => string }[] }[] } }).Konva.stages[0]!;
      return st.getLayers().map((l) => l.name());
    });
    expect(layers.length).toBeLessThanOrEqual(5);
    expect(layers).toContain('drag-layer');
    expect(warnings).toEqual([]);
  });
});
