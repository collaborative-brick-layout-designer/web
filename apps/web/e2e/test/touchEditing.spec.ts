// Touch editing on phones and tablets. A phone opens a layout in View
// mode; Edit (for people who can edit) turns on touch editing: tap to
// pick, drag a picked part (with the desktop's connection snapping),
// one finger pans, two fingers pinch, a long press picks more, a bottom
// bar rotates, duplicates and deletes, "Add part" places a part, and
// Undo / Redo work. The layout on the server must show the changes.
//
// Touches are sent through CDP (Input.dispatchTouchEvent), so this runs
// in Chromium with the phones' touch screens and sizes.
// SHOTS_DIR=<dir> also saves screenshots, light and dark.

import { test, expect, devices, type Page, type CDPSession } from '@playwright/test';
import { signIn } from '../helpers';

const SHOTS = process.env.SHOTS_DIR;
const PART = 'ts_narrowgauge_straight.8';

const { defaultBrowserType: _a, ...iPhone14 } = devices['iPhone 14'];
const { defaultBrowserType: _b, ...pixel7 } = devices['Pixel 7'];
const { defaultBrowserType: _c, ...iPad } = devices['iPad (gen 7)'];

const ts = Date.now();
let seq = 0;

interface Brick {
  id: string;
  /** Centre in studs, and rotation. */
  x: number;
  y: number;
  rot: number;
  /** Centre on the screen. */
  sx: number;
  sy: number;
}

function bricks(page: Page): Promise<Brick[]> {
  return page.evaluate(() => {
    type N = {
      name: () => string;
      getClassName: () => string;
      x: () => number;
      y: () => number;
      rotation: () => number;
      getAbsolutePosition: () => { x: number; y: number };
    };
    const st = (window as unknown as {
      Konva?: { stages: { container: () => HTMLElement; find: (f: (n: N) => boolean) => N[] }[] };
    }).Konva?.stages[0];
    if (!st) return [];
    const box = st.container().getBoundingClientRect();
    return st
      .find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-'))
      .map((n) => {
        const a = n.getAbsolutePosition();
        return { id: n.name().slice(6), x: n.x() / 8, y: n.y() / 8, rot: n.rotation(), sx: box.left + a.x, sy: box.top + a.y };
      });
  });
}

const stageX = (page: Page) =>
  page.evaluate(() => (window as unknown as { Konva: { stages: { x: () => number }[] } }).Konva.stages[0]!.x());

class Finger {
  constructor(private cdp: CDPSession) {}
  static async on(page: Page): Promise<Finger> {
    return new Finger(await page.context().newCDPSession(page));
  }
  private send(type: string, pts: { x: number; y: number }[]) {
    return this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })) });
  }
  async drag(from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
    await this.send('touchStart', [from]);
    for (let i = 1; i <= steps; i++) {
      await this.send('touchMove', [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }]);
    }
    await this.send('touchEnd', []);
  }
  async tap(p: { x: number; y: number }) {
    await this.send('touchStart', [p]);
    await this.send('touchEnd', []);
  }
  async longPress(p: { x: number; y: number }, page: Page) {
    await this.send('touchStart', [p]);
    await page.waitForTimeout(800);
    await this.send('touchEnd', []);
  }
  async pinchOut(c: { x: number; y: number }) {
    await this.send('touchStart', [{ x: c.x - 20, y: c.y }, { x: c.x + 20, y: c.y }]);
    for (let d = 30; d <= 60; d += 10) await this.send('touchMove', [{ x: c.x - d, y: c.y }, { x: c.x + d, y: c.y }]);
    await this.send('touchEnd', []);
  }
}

async function newLayout(page: Page, who: string): Promise<string> {
  await signIn(page, `touch-${who.replace(/\W+/g, '-').toLowerCase()}-${ts}-${seq++}@example.com`, 'Touch Editor');
  const res = await page.request.post('/api/layouts', { data: { title: 'Touch layout' } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  return id;
}

/** The layout as the server keeps it, once this page has gone (the server writes it when the last client leaves). */
async function serverBricks(page: Page, id: string): Promise<{ part: string; x: number; y: number; w: number; h: number; rot: number }[]> {
  const ctx = page.context();
  await page.close();
  const p2 = await ctx.newPage();
  await expect
    .poll(async () => (await p2.request.get(`/api/layouts/${id}/export.bbm`)).status(), { timeout: 10000 })
    .toBe(200);
  // The server writes the doc a moment after the last socket closes.
  await p2.waitForTimeout(1500);
  const xml = await (await p2.request.get(`/api/layouts/${id}/export.bbm`)).text();
  await p2.close();
  return [...xml.matchAll(/<Brick [^>]*>([\s\S]*?)<\/Brick>/g)].map((m) => {
    const body = m[1]!;
    const num = (tag: string) => Number(new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(body)?.[1] ?? NaN);
    return {
      part: /<PartNumber>([^<]*)<\/PartNumber>/.exec(body)?.[1] ?? '',
      x: num('X'),
      y: num('Y'),
      w: num('Width'),
      h: num('Height'),
      rot: num('Orientation'),
    };
  });
}

/** Light and dark screenshots. */
async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.screenshot({ path: `${SHOTS}/${name}-light.png` });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${SHOTS}/${name}-dark.png` });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
}

const bar = (page: Page) => page.getByTestId('touch-bar');

for (const phone of [
  { name: 'Pixel 7', use: pixel7 },
  { name: 'iPhone 14', use: iPhone14 },
]) {
  test.describe(`touch editing on ${phone.name}`, () => {
    test.use(phone.use);

    test('Edit: add, pick, drag with snapping, rotate, duplicate, delete, undo, and the server has it', async ({ page, browserName }) => {
      test.skip(browserName !== 'chromium', 'uses CDP touch emulation');
      const slug = phone.name.replace(/\W+/g, '-').toLowerCase();
      const id = await newLayout(page, phone.name);
      const finger = await Finger.on(page);

      // View is the default: no editing controls.
      const sw = page.getByTestId('mode-switch');
      await expect(sw.getByRole('radio', { name: 'View' })).toHaveAttribute('aria-checked', 'true');
      await expect(bar(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);

      // Edit.
      await sw.getByRole('radio', { name: 'Edit' }).tap();
      await expect(sw.getByRole('radio', { name: 'Edit' })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
      await expect(page.getByRole('toolbar', { name: 'Edit', exact: true })).toHaveCount(0); // not the desktop toolbar

      // Add part: the sheet slides up, search, place at the centre.
      await page.getByTestId('add-part').tap();
      const sheet = page.getByRole('dialog', { name: 'Add a part' });
      await expect(sheet).toBeVisible();
      await sheet.getByRole('searchbox', { name: 'Search parts' }).fill('narrow gauge track straight 4 x 16');
      await expect(sheet.locator(`[data-part-key="${PART}"]`)).toBeVisible();
      await shoot(page, `phone-${slug}-add-part`);
      await sheet.locator(`[data-part-key="${PART}"]`).tap();
      await expect(sheet).toHaveCount(0);
      await expect.poll(() => bricks(page).then((b) => b.length)).toBe(1);
      await expect(bar(page)).toHaveAttribute('aria-label', '1 picked');

      // At 100% a 16-stud track is 128 px: plenty for a finger.
      const area = (await page.getByTestId('canvas-area').boundingBox())!;
      let [a] = await bricks(page);

      // Drag the picked part: it moves; the view doesn't.
      const x0 = await stageX(page);
      await finger.drag({ x: a!.sx, y: a!.sy }, { x: a!.sx - 40, y: a!.sy - 30 });
      await expect.poll(async () => (await bricks(page))[0]!.x).toBeLessThan(a!.x - 1);
      expect(await stageX(page)).toBeCloseTo(x0, 3);
      [a] = await bricks(page);

      // Rotate right, and back with Undo.
      await bar(page).getByRole('button', { name: 'Turn right' }).tap();
      await expect.poll(async () => (await bricks(page))[0]!.rot).not.toBe(a!.rot);
      const turned = (await bricks(page))[0]!.rot;
      await page.getByRole('button', { name: 'Undo' }).tap();
      await expect.poll(async () => (await bricks(page))[0]!.rot).toBe(a!.rot);
      await page.getByRole('button', { name: 'Redo' }).tap();
      await expect.poll(async () => (await bricks(page))[0]!.rot).toBe(turned);
      // And left again, for an easy straight line.
      await bar(page).getByRole('button', { name: 'Turn left' }).tap();
      await expect.poll(async () => (await bricks(page))[0]!.rot).toBe(a!.rot);

      // Duplicate: the copy lands beside it, picked.
      await bar(page).getByRole('button', { name: 'Duplicate' }).tap();
      await expect.poll(() => bricks(page).then((b) => b.length)).toBe(2);
      let all = await bricks(page);
      const copy = all.find((b) => b.id !== a!.id)!;
      expect(copy.x).toBeGreaterThan(a!.x + 8);
      await shoot(page, `phone-${slug}-picked`);

      // Drag the copy towards the first: it snaps end to end (connection snap).
      const into = copy.sx - (copy.sx - a!.sx) * 0.15; // most of the gap closed, but not exactly
      await finger.drag({ x: copy.sx, y: copy.sy }, { x: into - (copy.sx - a!.sx) * 0.12, y: copy.sy + 3 });
      await expect.poll(async () => {
        const c = (await bricks(page)).find((b) => b.id === copy.id)!;
        return Math.round((c.x - a!.x) * 1000) / 1000;
      }).toBe(16);
      all = await bricks(page);
      expect(all.find((b) => b.id === copy.id)!.y).toBeCloseTo(a!.y, 3);

      // Tap empty map: nothing picked; the bar offers Add part again.
      await finger.tap({ x: area.x + 30, y: area.y + area.height / 2 + 120 });
      await expect(page.getByTestId('add-part')).toBeVisible();

      // A tap picks a part; a long press picks another as well.
      const [b1, b2] = await bricks(page);
      await finger.tap({ x: b1!.sx, y: b1!.sy });
      await expect(bar(page)).toHaveAttribute('aria-label', '1 picked');
      await finger.longPress({ x: b2!.sx, y: b2!.sy }, page);
      await expect(bar(page)).toHaveAttribute('aria-label', '2 picked');
      await expect(bar(page).getByRole('button', { name: 'Select more' })).toHaveAttribute('aria-pressed', 'true');

      // One finger on empty map pans the view, and moves no part.
      const before = await bricks(page);
      const px = await stageX(page);
      await finger.drag({ x: area.x + 30, y: area.y + 120 }, { x: area.x + 90, y: area.y + 120 });
      expect((await stageX(page)) - px).toBeCloseTo(60, 0);
      const after = await bricks(page);
      for (const b of before) expect(after.find((c) => c.id === b.id)!.x).toBeCloseTo(b.x, 6);

      // Delete both, then Undo brings them back.
      await bar(page).getByRole('button', { name: 'Delete' }).tap();
      await expect.poll(() => bricks(page).then((b) => b.length)).toBe(0);
      await page.getByRole('button', { name: 'Undo' }).tap();
      await expect.poll(() => bricks(page).then((b) => b.length)).toBe(2);

      // Nothing on the page zoomed or scrolled.
      expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
      expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);

      // 44 px buttons in the editing controls.
      const small = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('[data-testid="touch-bar"] button, [data-testid="mode-switch"] button, button[aria-label="Undo"], button[aria-label="Redo"]'))
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width < 44 || r.height < 43.5).length,
      );
      expect(small).toBe(0);
      await shoot(page, `phone-${slug}-edit`);

      // The server has both parts, end to end.
      const saved = await serverBricks(page, id);
      expect(saved).toHaveLength(2);
      expect(saved.every((b) => b.part.toLowerCase() === PART)).toBe(true);
      const [s1, s2] = saved.sort((p, q) => p.x - q.x);
      expect(s2!.x - s1!.x).toBeCloseTo(16, 3);
      expect(s2!.y).toBeCloseTo(s1!.y, 3);
    });
  });
}

test.describe('picking by touch with a box', () => {
  test.use(pixel7);

  test('"Select area" draws a box that picks what it touches, and the map stays put', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'uses CDP touch emulation');
    await newLayout(page, 'select-area');
    const finger = await Finger.on(page);
    await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
    // Two parts side by side, then nothing picked.
    await page.getByTestId('add-part').tap();
    const sheet = page.getByRole('dialog', { name: 'Add a part' });
    await sheet.getByRole('searchbox', { name: 'Search parts' }).fill('narrow gauge track straight 4 x 16');
    await sheet.locator(`[data-part-key="${PART}"]`).tap();
    await expect.poll(() => bricks(page).then((b) => b.length)).toBe(1);
    await bar(page).getByRole('button', { name: 'Duplicate' }).tap();
    await expect.poll(() => bricks(page).then((b) => b.length)).toBe(2);
    await bar(page).getByRole('button', { name: 'Done' }).tap();
    await expect(page.getByTestId('add-part')).toBeVisible();

    await bar(page).getByRole('button', { name: 'Select area' }).tap();
    await expect(bar(page).getByRole('button', { name: 'Select area' })).toHaveAttribute('aria-pressed', 'true');
    await expect(bar(page).getByRole('status')).toContainText('Drag a box');
    const all = await bricks(page);
    const left = Math.min(...all.map((b) => b.sx)) - 90;
    const right = Math.max(...all.map((b) => b.sx)) + 90;
    const top = Math.min(...all.map((b) => b.sy)) - 40;
    const bottom = Math.max(...all.map((b) => b.sy)) + 40;
    const x0 = await stageX(page);
    await finger.drag({ x: left, y: top }, { x: right, y: bottom });
    await expect(bar(page)).toHaveAttribute('aria-label', '2 picked');
    expect(await stageX(page)).toBeCloseTo(x0, 3);
    const after = await bricks(page);
    for (const b of all) expect(after.find((c) => c.id === b.id)!.x).toBeCloseTo(b.x, 6);
    await shoot(page, 'phone-select-area');

    // A box around one part only picks that one.
    await bar(page).getByRole('button', { name: 'Done' }).tap();
    await expect(bar(page).getByRole('button', { name: 'Select area' })).toHaveAttribute('aria-pressed', 'false');
    await bar(page).getByRole('button', { name: 'Select area' }).tap();
    const [first] = all.sort((p, q) => p.sx - q.sx);
    await finger.drag({ x: first!.sx - 20, y: first!.sy - 20 }, { x: first!.sx + 20, y: first!.sy + 20 });
    await expect(bar(page)).toHaveAttribute('aria-label', '1 picked');
    // Off again: one finger pans as before.
    await bar(page).getByRole('button', { name: 'Select area' }).tap();
    const area = (await page.getByTestId('canvas-area').boundingBox())!;
    const px = await stageX(page);
    await finger.drag({ x: area.x + 30, y: area.y + 120 }, { x: area.x + 90, y: area.y + 120 });
    expect((await stageX(page)) - px).toBeCloseTo(60, 0);
  });
});

test.describe('sheets by touch', () => {
  test.use(pixel7);

  test('the Sheets button shows, hides, renames and reorders sheets, and the server keeps it', async ({ page }) => {
    await newLayout(page, 'sheets');
    await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
    await bar(page).getByRole('button', { name: 'Sheets' }).tap();
    const sheet = page.getByRole('dialog', { name: 'Sheets' });
    await expect(sheet).toBeVisible();
    const rows = sheet.getByRole('list', { name: 'Sheets, top first' }).getByRole('listitem');
    const count = await rows.count();
    expect(count).toBeGreaterThan(1);
    const top = (await rows.first().locator('.font-bold').textContent())!;
    const second = (await rows.nth(1).locator('.font-bold').textContent())!;

    await sheet.getByRole('button', { name: `Rename ${top}` }).tap();
    await sheet.getByRole('textbox', { name: `New name for ${top}` }).fill('Main line');
    await sheet.getByRole('button', { name: 'Save' }).tap();
    await sheet.getByRole('button', { name: 'Hide Main line' }).tap();
    await expect(sheet.getByRole('button', { name: 'Show Main line' })).toHaveAttribute('aria-pressed', 'false');
    await sheet.getByRole('button', { name: 'Move Main line down' }).tap();
    await expect(rows.nth(0).locator('.font-bold')).toHaveText(second);
    await expect(rows.nth(1).locator('.font-bold')).toHaveText('Main line');
    await shoot(page, 'phone-sheets');
    // Finger-sized.
    for (const b of await sheet.getByRole('button', { name: /^(Show|Hide|Rename|Move) / }).all()) {
      const r = (await b.boundingBox())!;
      expect(r.width).toBeGreaterThanOrEqual(44);
      expect(r.height).toBeGreaterThanOrEqual(43.5);
    }
    await sheet.getByRole('button', { name: 'Close' }).last().tap();
    await expect(sheet).toHaveCount(0);

    // Back from the server.
    await page.waitForTimeout(1500);
    await page.reload();
    await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
    await bar(page).getByRole('button', { name: 'Sheets' }).tap();
    await expect(rows.nth(1).locator('.font-bold')).toHaveText('Main line');
    await expect(sheet.getByRole('button', { name: 'Show Main line' })).toBeVisible();
  });
  test('a finger adds a sheet, fades it, and deletes one after a question that says what is on it', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'uses CDP touch emulation');
    const id = await newLayout(page, 'sheets-add');
    await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
    // A part on the picked parts sheet, so the delete question has something to say.
    await page.getByTestId('add-part').tap();
    const parts = page.getByRole('dialog', { name: 'Add a part' });
    await parts.getByRole('searchbox', { name: 'Search parts' }).fill('narrow gauge track straight 4 x 16');
    await parts.locator(`[data-part-key="${PART}"]`).tap();
    await expect(parts).toHaveCount(0);
    await bar(page).getByRole('button', { name: 'Done' }).tap();

    await bar(page).getByRole('button', { name: 'Sheets' }).tap();
    const sheet = page.getByRole('dialog', { name: 'Sheets' });
    const rows = sheet.getByRole('list', { name: 'Sheets, top first' }).getByRole('listitem');
    const before = await rows.count();

    // Add: the kinds, each with what it is for.
    await sheet.getByRole('button', { name: 'Add a sheet' }).tap();
    const kinds = sheet.getByRole('group', { name: 'Add a sheet' });
    for (const k of ['Parts sheet', 'Text sheet', 'Area sheet', 'Ruler sheet', 'Grid sheet']) await expect(kinds.getByText(k, { exact: true })).toBeVisible();
    await shoot(page, 'phone-sheets-add');
    await kinds.getByText('Text sheet', { exact: true }).tap();
    await expect(rows).toHaveCount(before + 1);
    // On top, and picked.
    await expect(rows.first()).toContainText('picked sheet');
    const added = (await rows.first().locator('.font-bold').textContent())!;

    // Fade it: a finger on the Solid slider, a quarter of the way along.
    const slider = sheet.getByRole('slider', { name: `How solid ${added} is` });
    const box = (await slider.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(43.5);
    await slider.tap({ position: { x: box.width * 0.25, y: box.height / 2 } });
    await expect.poll(async () => Number(await slider.inputValue())).toBeLessThan(50);
    const faded = Number(await slider.inputValue());
    await shoot(page, 'phone-sheets-fade');

    // Delete the parts sheet: the question names it and its part; Cancel keeps it.
    const partsRow = rows.filter({ hasText: '1 part' });
    const partsName = (await partsRow.locator('.font-bold').textContent())!;
    await partsRow.getByRole('button', { name: `Delete ${partsName}` }).tap();
    const ask = page.getByTestId('confirm-dialog');
    await expect(ask).toContainText(`Delete the sheet “${partsName}”?`);
    await expect(ask).toContainText('along with 1 part on it');
    await shoot(page, 'phone-sheets-delete');
    await ask.getByRole('button', { name: 'Cancel' }).tap();
    await expect(rows).toHaveCount(before + 1);
    await expect(sheet).toBeVisible();
    await partsRow.getByRole('button', { name: `Delete ${partsName}` }).tap();
    await ask.getByRole('button', { name: 'Delete' }).tap();
    await expect(rows).toHaveCount(before);
    await expect(bricks(page).then((b) => b.length)).resolves.toBe(0);

    // Every control is finger-sized.
    for (const b of await sheet.getByRole('button').all()) {
      if (!(await b.isVisible())) continue;
      const r = (await b.boundingBox())!;
      expect(r.height, (await b.getAttribute('aria-label')) ?? (await b.textContent()) ?? '').toBeGreaterThanOrEqual(43.5);
    }
    await sheet.getByRole('button', { name: 'Close' }).last().tap();

    // The server has it: the new text sheet, faded; the parts sheet gone.
    const ctx = page.context();
    await page.close();
    const p2 = await ctx.newPage();
    await p2.waitForTimeout(1500);
    const xml = await (await p2.request.get(`/api/layouts/${id}/export.bbm`)).text();
    const layers = [...xml.matchAll(/<Layer type="(\w+)"[^>]*>\s*<Name>([^<]*)<\/Name>\s*<Visible>[^<]*<\/Visible>\s*<Transparency>(\d+)<\/Transparency>/g)].map((m) => ({ type: m[1], name: m[2], t: Number(m[3]) }));
    expect(layers.find((l) => l.name === added)).toEqual({ type: 'text', name: added, t: faded });
    expect(layers.find((l) => l.name === partsName)).toBeUndefined();
    expect(xml).not.toContain('<Brick ');
    await p2.close();
  });
});

test.describe('labels by touch', () => {
  test.use(pixel7);

  test('a tap picks a label, a finger drags it, and Edit text changes its words', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'uses CDP touch emulation');
    await signIn(page, `touch-labels-${ts}-${seq++}@example.com`, 'Touch Editor');
    const label = {
      id: 'lbl-station', text: 'Station', font: { family: 'Microsoft Sans Serif', size: 36, style: 'Bold' },
      color: { known: true, argb: -16777216, name: 'Black' }, kind: 0, targetId: '', offset: { x: 20, y: 20 }, rot: 0, minZoom: 0,
    };
    const res = await page.request.post('/api/layouts', {
      data: { title: 'Labels', sidecar: JSON.stringify({ schemaVersion: 1, bbmHashSha256: '', anchoredLabels: [label] }) },
    });
    expect(res.ok(), await res.text()).toBe(true);
    const { id } = (await res.json()) as { id: string };
    await page.goto(`/editor/${id}`);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
    await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
    const finger = await Finger.on(page);

    const where = () =>
      page.evaluate(() => {
        type N = { getClientRect: () => { x: number; y: number; width: number; height: number }; findOne: (s: string) => { text: () => string; x: () => number } };
        const st = (window as unknown as { Konva?: { stages: { container: () => HTMLElement; findOne: (s: string) => N | undefined }[] } }).Konva?.stages[0];
        const g = st?.findOne('.label-lbl-station');
        if (!st || !g) return null;
        const r = g.getClientRect();
        const box = st.container().getBoundingClientRect();
        const t = g.findOne('Text');
        return { x: box.left + r.x + r.width / 2, y: box.top + r.y + r.height / 2, text: t.text(), worldX: t.x() };
      });
    await expect.poll(async () => (await where())?.text).toBe('Station');
    const at = (await where())!;

    // A tap picks it: the bar offers Edit text, and nothing for parts.
    await finger.tap({ x: at.x, y: at.y });
    await expect(bar(page)).toHaveAttribute('aria-label', '1 picked');
    await expect(bar(page).getByRole('button', { name: 'Edit text' })).toBeVisible();
    await expect(bar(page).getByRole('button', { name: 'Turn left' })).toHaveCount(0);

    // A finger on the picked label drags it; the map stays put.
    const x0 = await stageX(page);
    await finger.drag({ x: at.x, y: at.y }, { x: at.x + 60, y: at.y + 40 });
    await expect.poll(async () => Math.round((await where())!.x - at.x)).toBeGreaterThan(40);
    expect(await stageX(page)).toBeCloseTo(x0, 3);
    await expect(bar(page)).toHaveAttribute('aria-label', '1 picked');

    // Edit text, in a sheet from the bottom.
    await bar(page).getByRole('button', { name: 'Edit text' }).tap();
    const sheet = page.getByRole('dialog', { name: 'Edit label' });
    await expect(sheet.getByRole('textbox', { name: 'Text' })).toHaveValue('Station');
    await sheet.getByRole('textbox', { name: 'Text' }).fill('Main station');
    await shoot(page, 'phone-edit-label');
    await sheet.getByRole('button', { name: 'Save' }).tap();
    await expect(sheet).toHaveCount(0);
    await expect.poll(async () => (await where())?.text).toBe('Main station');
    const moved = (await where())!;

    // The server has both.
    await page.waitForTimeout(1500);
    await page.reload();
    await expect.poll(async () => (await where())?.text, { timeout: 15000 }).toBe('Main station');
    // Moved in the layout (not just on screen), and kept: 20 studs = 160 px before the drag.
    expect(moved.worldX).toBeGreaterThan(160 + 1);
    expect((await where())!.worldX).toBeCloseTo(moved.worldX, 3);
  });
});

test.describe('the View / Edit choice', () => {
  test.use(pixel7);

  test('is kept per layout for the visit, and viewers never see Edit', async ({ page, browser }) => {
    const id = await newLayout(page, 'choice');
    await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
    await expect(page.getByTestId('add-part')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('add-part')).toBeVisible();
    await page.getByTestId('mode-switch').getByRole('radio', { name: 'View' }).tap();
    await expect(page.getByTestId('add-part')).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('mode-switch').getByRole('radio', { name: 'View' })).toHaveAttribute('aria-checked', 'true');
    // Another layout starts in View.
    await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
    const other = (await (await page.request.post('/api/layouts', { data: { title: 'Other' } })).json()) as { id: string };
    await page.goto(`/editor/${other.id}`);
    await expect(page.getByTestId('mode-switch').getByRole('radio', { name: 'View' })).toHaveAttribute('aria-checked', 'true');

    // A viewer: "View only", no switch.
    const viewerEmail = `touch-viewer-${ts}@example.com`;
    const ctx = await browser.newContext({ ...pixel7 });
    const vp = await ctx.newPage();
    await signIn(vp, viewerEmail, 'Touch Viewer');
    const inv = await page.request.post(`/api/layouts/${id}/invites`, { data: { email: viewerEmail, role: 'viewer' } });
    expect(inv.ok(), await inv.text()).toBe(true);
    const { token } = (await inv.json()) as { token: string };
    expect((await vp.request.post(`/api/invites/${token}`)).ok()).toBe(true);
    await vp.goto(`/editor/${id}`);
    await expect(vp.getByTestId('view-only')).toBeVisible();
    await expect(vp.getByTestId('mode-switch')).toHaveCount(0);
    await expect(vp.getByTestId('touch-bar')).toHaveCount(0);
    await ctx.close();
  });
});

test.describe('touch editing on a tablet', () => {
  test.use(iPad);

  test('the full editor: tap picks, a finger drags the picked part, one finger pans, the bar acts', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'uses CDP touch emulation');
    const id = await newLayout(page, 'tablet');
    // The full editor, not the phone viewer.
    await expect(page.getByRole('toolbar', { name: 'Edit', exact: true })).toBeVisible();
    await expect(page.getByTestId('mode-switch')).toHaveCount(0);
    // Place a part from the parts panel.
    await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
    await page.locator(`[title*="(${PART})"]`).first().dblclick();
    await expect.poll(() => bricks(page).then((b) => b.length)).toBe(1);
    const finger = await Finger.on(page);
    const area = (await page.getByTestId('canvas-area').boundingBox())!;
    await finger.pinchOut({ x: area.x + area.width / 2, y: area.y + area.height / 2 });
    // Nothing picked: a finger on the part moves the view, not the part.
    await finger.tap({ x: area.x + 20, y: area.y + 80 });
    await expect(bar(page)).toHaveAttribute('aria-label', 'Touch editing');
    let [a] = await bricks(page);
    const x0 = await stageX(page);
    await finger.drag({ x: a!.sx, y: a!.sy }, { x: a!.sx + 50, y: a!.sy });
    expect((await stageX(page)) - x0).toBeCloseTo(50, 0);
    expect((await bricks(page))[0]!.x).toBeCloseTo(a!.x, 6);
    // ...and Konva never dragged it along (a drag ends with "Moved" or a
    // connection snap in the status bar).
    await expect(page.locator('footer')).not.toContainText(/Moved|Connection snap/);
    // Tap picks it; the bar for picked parts shows.
    [a] = await bricks(page);
    await finger.tap({ x: a!.sx, y: a!.sy });
    await expect(bar(page)).toHaveAttribute('aria-label', '1 picked');
    // Now the finger drags the part.
    await finger.drag({ x: a!.sx, y: a!.sy }, { x: a!.sx + 60, y: a!.sy + 40 });
    await expect.poll(async () => (await bricks(page))[0]!.x).toBeGreaterThan(a!.x + 1);
    await bar(page).getByRole('button', { name: 'Turn right' }).tap();
    await expect.poll(async () => (await bricks(page))[0]!.rot).not.toBe(a!.rot);
    await shoot(page, 'tablet-edit');
    // With nothing picked, the bar offers the same Add part sheet as a phone.
    await bar(page).getByRole('button', { name: 'Done' }).tap();
    await page.getByTestId('add-part').tap();
    const sheet = page.getByRole('dialog', { name: 'Add a part' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('searchbox', { name: 'Search parts' }).fill('narrow gauge track straight 4 x 16');
    await shoot(page, 'tablet-add-part');
    await sheet.locator(`[data-part-key="${PART}"]`).tap();
    await expect(sheet).toHaveCount(0);
    await expect.poll(() => bricks(page).then((b) => b.length)).toBe(2);
    await expect(bar(page)).toHaveAttribute('aria-label', '1 picked');
    const saved = await serverBricks(page, id);
    expect(saved).toHaveLength(2);
    expect(saved.some((b) => b.rot !== 0)).toBe(true);
  });
});

test.describe('sheets on a tablet', () => {
  test.use(iPad);

  test('the Sheets panel has finger-sized controls, and the touch bar opens the full Sheets list', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'uses CDP touch emulation');
    await newLayout(page, 'tablet-sheets');
    const panel = page.locator('aside').filter({ hasText: 'Sheets' }).first();
    await expect(panel).toBeVisible();
    for (const name of ['Add sheet', '▲', '▼', 'Remove sheet', 'Show all', 'Solo']) {
      const r = (await panel.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(r.height, name).toBeGreaterThanOrEqual(43.5);
    }
    await shoot(page, 'tablet-sheets-panel');
    await bar(page).getByRole('button', { name: 'Sheets' }).tap();
    const sheet = page.getByRole('dialog', { name: 'Sheets' });
    await expect(sheet.getByRole('button', { name: 'Add a sheet' })).toBeVisible();
    await expect(sheet.getByRole('slider').first()).toBeVisible();
    await expect(sheet.getByRole('button', { name: /^Delete / }).first()).toBeVisible();
    await shoot(page, 'tablet-sheets');
  });
});
