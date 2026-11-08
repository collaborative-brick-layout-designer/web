// Journeys for the week's BlueBrick-parity and live-editing fixes
// (Aaron, 2026-10-11: "You should have tests for all of this"):
// - text is dragged to move it (web #310);
// - text and rulers come to the front / go to the back from their
//   right-click menu (web #309);
// - two people making modules at once both keep theirs (web #308).

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn, mapMenu } from '../helpers';

const FORDYCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm'),
  'utf-8',
);

async function newLayout(page: Page, who: string): Promise<string> {
  await signIn(page, `${who}-${Date.now()}@example.com`, who);
  const res = await page.request.post('/api/layouts', { data: { title: 'Week fixes', bbm: FORDYCE } });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function open(page: Page, id: string): Promise<void> {
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1000);
}

/** The centre on screen of the first Konva node matching `selector` (e.g. '.text-cell'). */
async function centreOf(page: Page, selector: string): Promise<{ x: number; y: number; name: string }> {
  return page.evaluate((sel) => {
    type N = { name: () => string; getClientRect: () => { x: number; y: number; width: number; height: number }; getStage: () => { container: () => HTMLElement }; isVisible: () => boolean };
    const K = (window as unknown as { Konva: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva;
    // `.name` or a name prefix ending in `*`.
    const want = sel.replace(/^\./, '');
    const match = (n: N) => n.name().split(' ').some((x) => (want.endsWith('*') ? x.startsWith(want.slice(0, -1)) : x === want));
    for (const st of K.stages) {
      for (const n of st.find(match)) {
        if (!n.isVisible()) continue;
        const r = n.getClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const c = n.getStage().container().getBoundingClientRect();
        return { x: c.left + r.x + r.width / 2, y: c.top + r.y + r.height / 2, name: n.name() };
      }
    }
    throw new Error(`no visible node ${sel}`);
  }, selector);
}

async function exported(page: Page, id: string): Promise<string> {
  return (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
}

/** The text cells' texts in file order, from the exported .bbm. */
function textOrder(bbm: string): string[] {
  return [...bbm.matchAll(/<TextCell[^>]*>[\s\S]*?<Text>([\s\S]*?)<\/Text>/g)].map((m) => m[1]!);
}

test('text: drag it to move it, and bring it to the front from its menu', async ({ page }) => {
  const id = await newLayout(page, 'text-journey');
  await open(page, id);
  await page.getByRole('button', { name: 'Fit' }).first().click().catch(() => undefined);
  const before = textOrder(await exported(page, id));
  expect(before.length).toBeGreaterThan(1);

  // Right-click a text: its menu has Bring to Front, which puts it last in its sheet.
  const t = await centreOf(page, '.text-cell');
  await page.mouse.click(t.x, t.y, { button: 'right' });
  await page.locator('[data-ctx-menu]').getByRole('button', { name: 'Bring to front' }).click();
  await expect.poll(async () => textOrder(await exported(page, id)).join('|')).not.toBe(before.join('|'));
  const afterFront = textOrder(await exported(page, id));
  const moved = afterFront[afterFront.length - 1]!;
  expect(before).toContain(moved);

  // Drag it: its box moves (the .bbm's DisplayArea changes).
  const area = (bbm: string) => bbm.match(new RegExp(`<TextCell[^>]*>(?:(?!</TextCell>)[\\s\\S])*?<Text>${moved.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</Text>`))?.[0]?.match(/<X>([^<]*)<\/X>/)?.[1];
  const x0 = area(await exported(page, id));
  // The same text, still where it was.
  await page.mouse.move(t.x, t.y);
  await page.mouse.down();
  await page.mouse.move(t.x + 60, t.y + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => area(await exported(page, id))).not.toBe(x0);
});

test('rulers: Bring to Front from its right-click menu reorders its sheet', async ({ page }) => {
  const id = await newLayout(page, 'ruler-journey');
  await open(page, id);
  // Rulers carry no id in the .bbm: their boxes, in file order, show the order.
  const ids = (bbm: string) => [...bbm.matchAll(/<(?:LinearRuler|CircularRuler)>\s*<DisplayArea>\s*<X>([^<]*)<\/X>\s*<Y>([^<]*)</g)].map((m) => `${m[1]},${m[2]}`);
  const before = ids(await exported(page, id));
  test.skip(before.length < 2, 'the fixture has fewer than two rulers');
  // Right-click inside a ruler's box (what the menu hit-tests), one that's on screen.
  const boxes = [...(await exported(page, id)).matchAll(/<(?:LinearRuler|CircularRuler)>\s*<DisplayArea>\s*<X>([^<]*)<\/X>\s*<Y>([^<]*)<\/Y>\s*<Width>([^<]*)<\/Width>\s*<Height>([^<]*)</g)]
    .map((m) => ({ x: +m[1]! + +m[3]! / 2, y: +m[2]! + +m[4]! / 2 }));
  const t = await page.evaluate(() => {
    const st = (window as unknown as { Konva: { stages: { x: () => number; y: () => number; scaleX: () => number }[] } }).Konva.stages[0]!;
    return { x: st.x(), y: st.y(), z: st.scaleX() };
  });
  const canvas = (await page.locator('.konvajs-content').first().boundingBox())!;
  const r = boxes
    .map((c) => ({ x: canvas.x + t.x + c.x * 8 * t.z, y: canvas.y + t.y + c.y * 8 * t.z }))
    .slice(0, -1) // not the last one: Bring to Front must change something
    .find((p) => p.x > canvas.x + 20 && p.x < canvas.x + canvas.width - 20 && p.y > canvas.y + 20 && p.y < canvas.y + canvas.height - 20);
  test.skip(!r, 'no ruler on screen');
  await page.mouse.click(r!.x, r!.y, { button: 'right' });
  await page.locator('[data-ctx-menu]').getByRole('button', { name: 'Bring to front' }).click();
  await expect.poll(async () => ids(await exported(page, id)).join('|')).not.toBe(before.join('|'));
});

test('two people making modules at the same time both keep theirs', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const email = `live-${Date.now()}@example.com`;
  await signIn(pa, email, 'Live');
  const res = await pa.request.post('/api/layouts', { data: { title: 'Live modules', bbm: FORDYCE } });
  const id = ((await res.json()) as { id: string }).id;
  // The same account in a second browser: another editor of the same layout.
  const pb = await b.newPage();
  await signIn(pb, email, 'Live');
  await open(pa, id);
  await open(pb, id);

  // Each picks a different part; B is offline while both make a module, so the edits are concurrent.
  const bricks = await pa.evaluate(() => {
    type N = { name: () => string };
    const K = (window as unknown as { Konva: { stages: { find: (s: string) => N[] }[] } }).Konva;
    return K.stages.flatMap((st) => st.find('Group').map((n) => n.name())).filter((n) => /^brick-/.test(n)).slice(0, 40);
  });
  expect(bricks.length).toBeGreaterThan(10);
  // Each picks a different part and fills in Make a module; both press it at the same moment.
  const pa1 = await centreOf(pa, `.${bricks[0]}`);
  await pa.mouse.click(pa1.x, pa1.y);
  const pb1 = await centreOf(pb, `.${bricks[bricks.length - 1]}`);
  await pb.mouse.click(pb1.x, pb1.y);
  const fill = async (p: Page, name: string) => {
    await mapMenu(p, 'Modules & sets', 'Make a module…');
    const dialog = p.getByRole('dialog', { name: 'Make a module' });
    await dialog.getByLabel('Module name').fill(name);
    return dialog;
  };
  const da = await fill(pa, 'Harbour A');
  const db = await fill(pb, 'Town B');
  await Promise.all([
    da.getByRole('button', { name: 'Make module' }).click(),
    db.getByRole('button', { name: 'Make module' }).click(),
  ]);
  await expect(da).toHaveCount(0, { timeout: 15000 });
  await expect(db).toHaveCount(0, { timeout: 15000 });

  const names = async () => {
    const r = await pa.request.get(`/api/layouts/${id}/export.bbm.bld`);
    return r.ok() ? ((await r.json()) as { modules?: { name: string }[] }).modules?.map((m) => m.name) ?? [] : [];
  };
  await expect.poll(async () => (await names()).sort().join('|'), { timeout: 20000 }).toContain('Harbour A');
  await expect.poll(async () => (await names()).sort().join('|'), { timeout: 20000 }).toContain('Town B');
  await a.close();
  await b.close();
});

test('rename a layout from Home and from the editor', async ({ page }) => {
  await signIn(page, `rename-${Date.now()}@example.com`, 'Renamer');
  const res = await page.request.post('/api/layouts', { data: { title: 'Old yard' } });
  const { id } = (await res.json()) as { id: string };
  await page.goto('/');
  await page.getByRole('button', { name: 'More for Old yard' }).click();
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  const box = page.getByRole('dialog', { name: 'Rename layout' });
  await box.getByRole('textbox').fill('New yard');
  await box.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByText('New yard', { exact: true }).first()).toBeVisible();

  await open(page, id);
  await page.locator('[data-tour="layout.menu"]').first().click();
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await box.getByRole('textbox').fill('Harbour yard');
  await box.getByRole('button', { name: 'Rename' }).click();
  await expect(page.locator('[data-tour="layout.menu"]').first()).toContainText('Harbour yard');
  expect(((await (await page.request.get(`/api/layouts/${id}`)).json()) as { layout: { title: string } }).layout.title).toBe('Harbour yard');
});

test('move picked parts to a new sheet from the right-click menu', async ({ page }) => {
  const id = await newLayout(page, 'sheet-move');
  await open(page, id);
  const sheetsWithParts = async () => {
    const bbm = await exported(page, id);
    return [...bbm.matchAll(/<Layer type="brick"[\s\S]*?<\/Layer>/g)].filter((m) => /<Brick /.test(m[0])).length;
  };
  const before = await sheetsWithParts();
  const p = await centreOf(page, 'brick-*');
  await page.mouse.click(p.x, p.y);
  await expect(page.locator('footer')).toContainText('selected: 1');
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await page.locator('[data-ctx-menu]').getByRole('button', { name: 'Move to a new sheet' }).click();
  await expect.poll(sheetsWithParts).toBe(before + 1);
  await expect(page.locator('footer')).toContainText('on sheet');
});

test('the grid snap can be set from Settings (a phone has no toolbar for it)', async ({ page }) => {
  await signIn(page, `snap-${Date.now()}@example.com`, 'Snapper');
  await page.goto('/settings');
  await page.getByTestId('settings-snap-step').selectOption('8');
  const res = await page.request.post('/api/layouts', { data: { title: 'Snap' } });
  await open(page, ((await res.json()) as { id: string }).id);
  await expect(page.getByTitle('Grid snap step (studs)').locator('select')).toHaveValue('8');
});
