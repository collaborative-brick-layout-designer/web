// The phone viewer ("mobile A"): what a club member sees opening a layout
// on a phone. Covers the problems seen on a real Android phone (412 px):
// the header running into itself, Undo / Redo in View mode, a fit
// that cut off column A and left a band above the layout, a scale card
// cut off by the screen bottom, plus pinch zoom, 44 px tap targets and
// no sideways page scroll on the main pages.
//
// SHOTS_DIR=<dir> also saves phone screenshots (light and dark).

import { test, expect, devices, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn } from '../helpers';

const FORDYCE_BBM = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/bbm/tests/fixtures/fordyce-2026.bbm'),
  'utf-8',
);
const SHOTS = process.env.SHOTS_DIR;

// Phone touch screens and user agents, in whichever browser the project runs.
const { defaultBrowserType: _a, ...iPhone14 } = devices['iPhone 14'];
const { defaultBrowserType: _b, ...pixel7 } = devices['Pixel 7'];
const PHONES = [
  { name: 'Pixel 7', use: pixel7 },
  { name: 'iPhone 14', use: iPhone14 },
  { name: 'small 360x740', use: { ...iPhone14, viewport: { width: 360, height: 740 } } },
  { name: 'Pixel 7 landscape', use: { ...pixel7, viewport: { width: 915, height: 412 } } },
];

const ts = Date.now();
let seq = 0;

async function openFordyce(page: Page, who: string): Promise<string> {
  await signIn(page, `mobile-${who.replace(/\W+/g, '-').toLowerCase()}-${ts}-${seq++}@example.com`, 'Phone Viewer');
  const res = await page.request.post('/api/layouts', { data: { title: 'Fordyce 2026', bbm: FORDYCE_BBM } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  // Wait for the bricks and the auto fit.
  await expect.poll(() => stageInfo(page).then((s) => s.bricks), { timeout: 15000 }).toBeGreaterThan(100);
  return id;
}

interface StageInfo {
  width: number;
  height: number;
  zoom: number;
  bricks: number;
  /** Union of every brick's box, in stage px. */
  box: { x1: number; y1: number; x2: number; y2: number };
  /** Grid labels drawn, with their boxes in stage px. */
  labels: { text: string; x1: number; y1: number; x2: number; y2: number }[];
}

function stageInfo(page: Page): Promise<StageInfo> {
  return page.evaluate(() => {
    type N = {
      name: () => string;
      getClientRect: () => { x: number; y: number; width: number; height: number };
      isVisible: () => boolean;
      text?: () => string;
      getParent: () => N | null;
    };
    const st = (window as unknown as {
      Konva?: { stages: { width: () => number; height: () => number; scaleX: () => number; find: (f: (n: N) => boolean) => N[] }[] };
    }).Konva?.stages[0];
    // Not rendered yet (the canvas code loads lazily).
    if (!st) return { width: 0, height: 0, zoom: 0, bricks: 0, box: { x1: 0, y1: 0, x2: 0, y2: 0 }, labels: [] };
    const bricks = st.find((n) => n.name().startsWith('brick-'));
    const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
    for (const b of bricks) {
      const r = b.getClientRect();
      box.x1 = Math.min(box.x1, r.x);
      box.y1 = Math.min(box.y1, r.y);
      box.x2 = Math.max(box.x2, r.x + r.width);
      box.y2 = Math.max(box.y2, r.y + r.height);
    }
    const labels = st
      .find((n) => n.getParent()?.name() === 'cell-index' && n.isVisible())
      .map((n) => {
        const r = n.getClientRect();
        return { text: n.text!(), x1: r.x, y1: r.y, x2: r.x + r.width, y2: r.y + r.height };
      });
    return { width: st.width(), height: st.height(), zoom: st.scaleX(), bricks: bricks.length, box, labels };
  });
}

/** Buttons, links meant as buttons, fields and selects smaller than 44 px (ignores links inside sentences). */
function smallTapTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const sel = 'button, [role=button], [role=menuitem], [role=radio], [role=tab], select, input, a';
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.tagName === 'A' && el.closest('p, li:not([class*="flex"])') && !el.classList.contains('tap-target')) continue;
      let w = r.width;
      let h = r.height;
      // A checkbox is tapped through its label.
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') && el.closest('label')) {
        const lr = el.closest('label')!.getBoundingClientRect();
        w = lr.width;
        h = lr.height;
      }
      if (el instanceof HTMLInputElement && el.type === 'file') continue;
      if (w < 44 || h < 43.5) out.push(`${el.tagName} "${(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${Math.round(w)}x${Math.round(h)}`);
    }
    return out;
  });
}

/**
 * Nothing runs off the right of the screen: neither the page, nor anything
 * inside the app's own scrolling panes (html and body don't scroll here, so
 * the page width alone would miss a row that overflows its pane). The map
 * itself is exempt; it is meant to extend past the edges.
 */
const noSidewaysScroll = (page: Page) =>
  page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw || document.body.scrollWidth > vw) return false;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (el.closest('[data-testid="canvas-area"]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 1 || r.left < -1) return false;
    }
    return true;
  });

/** Two fingers spread from 40 px to 160 px apart around the canvas centre (CDP touch). */
async function pinchOut(page: Page): Promise<void> {
  const canvas = (await page.getByTestId('canvas-area').boundingBox())!;
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: string, pts: { x: number; y: number }[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })) });
  await touch('touchStart', [{ x: cx - 20, y: cy }, { x: cx + 20, y: cy }]);
  for (let d = 30; d <= 80; d += 10) await touch('touchMove', [{ x: cx - d, y: cy }, { x: cx + d, y: cy }]);
  await touch('touchEnd', []);
  await cdp.detach();
}

for (const phone of PHONES) {
  test.describe(`phone viewer on ${phone.name}`, () => {
    test.use(phone.use);

    test('the whole layout fits, labels and scale card included, with a clean view-only header', async ({ page }) => {
      await openFordyce(page, phone.name);
      const canvas = (await page.getByTestId('canvas-area').boundingBox())!;
      const s = await stageInfo(page);

      // The stage is the canvas area's real size, not the window's.
      expect(Math.abs(s.width - canvas.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(s.height - canvas.height)).toBeLessThanOrEqual(1);

      // Every brick is inside the canvas, and the layout is centred.
      expect(s.box.x1).toBeGreaterThanOrEqual(0);
      expect(s.box.y1).toBeGreaterThanOrEqual(0);
      expect(s.box.x2).toBeLessThanOrEqual(s.width);
      expect(s.box.y2).toBeLessThanOrEqual(s.height);
      const left = s.box.x1;
      const right = s.width - s.box.x2;
      expect(Math.abs(left - right)).toBeLessThan(s.width * 0.2);
      // It fills the width on a portrait phone, or the height on its side:
      // no big empty band.
      const fillsW = (s.box.x2 - s.box.x1) / s.width;
      const fillsH = (s.box.y2 - s.box.y1) / s.height;
      expect(Math.max(fillsW, fillsH)).toBeGreaterThan(0.6);

      // Column A and row 1 are drawn, readable, and on screen.
      for (const text of ['A', '1']) {
        const l = s.labels.find((x) => x.text === text);
        expect(l, `grid label ${text}`).toBeTruthy();
        expect(l!.x1).toBeGreaterThanOrEqual(0);
        expect(l!.y1).toBeGreaterThanOrEqual(0);
        expect(l!.x2).toBeLessThanOrEqual(s.width);
        expect(l!.y2).toBeLessThanOrEqual(s.height);
      }

      // The scale card is fully on screen, inside the canvas.
      const card = (await page.getByTestId('scale-bar').boundingBox())!;
      const vp = page.viewportSize()!;
      expect(card.x).toBeGreaterThanOrEqual(0);
      expect(card.y + card.height).toBeLessThanOrEqual(canvas.y + canvas.height);
      expect(card.y + card.height).toBeLessThanOrEqual(vp.height);
      expect(card.x + card.width).toBeLessThanOrEqual(vp.width);
      // ...and it covers none of the grid's letters or row numbers.
      for (const l of s.labels) {
        const x1 = canvas.x + l.x1, x2 = canvas.x + l.x2, y1 = canvas.y + l.y1, y2 = canvas.y + l.y2;
        const overlaps = x2 > card.x && x1 < card.x + card.width && y2 > card.y && y1 < card.y + card.height;
        expect(overlaps, `scale card over grid label ${l.text}`).toBe(false);
      }

      // View mode (the default, with the switch to Edit for the owner):
      // no Undo / Redo, no edit toolbar.
      await expect(page.getByTestId('mode-switch').getByRole('radio', { name: 'View' })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Redo' })).toHaveCount(0);
      await expect(page.getByRole('toolbar', { name: 'Edit' })).toHaveCount(0);

      // Nothing in the header sits on anything else, and the title isn't squeezed.
      const header = page.getByTestId('editor-header');
      const boxes = await Promise.all(
        [
          header.locator('h1'),
          page.getByTestId('save-status'),
          page.getByTestId('mode-switch'),
          header.getByRole('button', { name: 'Share', exact: true }),
        ].map(async (l) => (await l.boundingBox())!),
      );
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
          expect(overlap, `header items ${i} and ${j} overlap`).toBe(false);
        }
      }
      expect(await header.locator('h1').evaluate((h) => h.scrollWidth <= h.clientWidth + 1)).toBe(true);
      const pill = page.getByTestId('mode-switch');
      expect(await pill.evaluate((p) => p.getBoundingClientRect().height)).toBeLessThan(52); // one line

      // The status bar's readouts aren't cut short.
      const cut = await page.getByTestId('status-bar').evaluate((f) =>
        Array.from(f.querySelectorAll('span')).filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent),
      );
      expect(cut).toEqual([]);

      expect(await noSidewaysScroll(page)).toBe(true);
      expect(await smallTapTargets(page)).toEqual([]);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/mobile-test-editor-${phone.name.replace(/\W+/g, '-').toLowerCase()}.png` });
    });
  });
}

test.describe('phone viewer gestures and pages', () => {
  test.use(pixel7);

  test('a pinch zooms the map, not the page, and one finger pans', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'uses CDP touch emulation');
    await openFordyce(page, 'pinch');
    const canvas = (await page.getByTestId('canvas-area').boundingBox())!;
    const before = await stageInfo(page);
    const cdp = await page.context().newCDPSession(page);
    const cx = canvas.x + canvas.width / 2;
    const cy = canvas.y + canvas.height / 2;
    const touch = (type: string, pts: { x: number; y: number }[]) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })) });

    // Two fingers 40 px apart spread to 160 px: 4x.
    await touch('touchStart', [{ x: cx - 20, y: cy }, { x: cx + 20, y: cy }]);
    for (let d = 30; d <= 80; d += 10) await touch('touchMove', [{ x: cx - d, y: cy }, { x: cx + d, y: cy }]);
    await touch('touchEnd', []);
    const after = await stageInfo(page);
    expect(after.zoom / before.zoom).toBeGreaterThan(3.5);
    expect(after.zoom / before.zoom).toBeLessThan(4.5);
    // The page itself did not zoom.
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);

    // One finger drags the view.
    const x0 = await page.evaluate(() => (window as unknown as { Konva: { stages: { x: () => number }[] } }).Konva.stages[0]!.x());
    await touch('touchStart', [{ x: cx, y: cy }]);
    await touch('touchMove', [{ x: cx + 30, y: cy }]);
    await touch('touchMove', [{ x: cx + 60, y: cy }]);
    await touch('touchEnd', []);
    const x1 = await page.evaluate(() => (window as unknown as { Konva: { stages: { x: () => number }[] } }).Konva.stages[0]!.x());
    expect(x1 - x0).toBeCloseTo(60, 0);

    // Once the user has moved the view, a resize doesn't fit again.
    const z = (await stageInfo(page)).zoom;
    await page.setViewportSize({ width: 412, height: 800 });
    await page.waitForTimeout(300);
    expect((await stageInfo(page)).zoom).toBeCloseTo(z, 6);
  });

  test('the fit follows the canvas size until the user moves the view', async ({ page }) => {
    await openFordyce(page, 'refit');
    const z1 = (await stageInfo(page)).zoom;
    // The browser bars hide: more height, same width (a width-bound fit keeps its zoom but re-centres).
    await page.setViewportSize({ width: 412, height: 980 });
    await expect.poll(async () => (await stageInfo(page)).height).toBeGreaterThan(700);
    let s = await stageInfo(page);
    expect(s.box.y1).toBeGreaterThanOrEqual(0);
    expect(Math.abs(s.box.y1 - (s.height - s.box.y2))).toBeLessThan(80);
    // Turned sideways: fits again, whole layout on screen.
    await page.setViewportSize({ width: 915, height: 412 });
    await expect.poll(async () => (await stageInfo(page)).zoom).not.toBeCloseTo(z1, 4);
    s = await stageInfo(page);
    expect(s.box.x1).toBeGreaterThanOrEqual(0);
    expect(s.box.y1).toBeGreaterThanOrEqual(0);
    expect(s.box.x2).toBeLessThanOrEqual(s.width);
    expect(s.box.y2).toBeLessThanOrEqual(s.height);
  });

  test('layouts list, settings, share and the public link work on a phone', async ({ page }) => {
    const id = await openFordyce(page, 'pages');
    // Share from the editor, on a short screen (browser bars showing): the
    // dialog fits and scrolls inside itself.
    const vp = page.viewportSize()!;
    await page.setViewportSize({ width: vp.width, height: 560 });
    await page.getByTestId('editor-header').getByRole('button', { name: 'Share', exact: true }).tap();
    const share = page.getByRole('dialog', { name: /^Share / });
    await expect(share).toBeVisible();
    const box = (await share.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(560);
    // Taller than that inside, so it scrolls, and the last section can be reached.
    expect(await share.evaluate((d) => d.scrollHeight > d.clientHeight && getComputedStyle(d).overflowY === 'auto')).toBe(true);
    await share.getByText('No collaborators yet.').scrollIntoViewIfNeeded();
    await expect(share.getByText('No collaborators yet.')).toBeInViewport();
    // Fields use 16 px text, so iOS doesn't zoom in on them.
    const email = share.locator('input[type=email]');
    expect(await email.evaluate((i) => parseFloat(getComputedStyle(i).fontSize))).toBeGreaterThanOrEqual(16);
    expect(await smallTapTargets(page)).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/mobile-test-share.png` });
    await share.getByRole('button', { name: 'Close' }).tap();
    await page.setViewportSize(vp);

    // The layouts list: the menu folds away, rows wrap, nothing scrolls sideways.
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Layouts' })).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    expect(await smallTapTargets(page)).toEqual([]);
    await expect(page.getByRole('navigation', { name: 'Site' })).toBeHidden();
    // One menu: a bottom sheet with the pages, Help and the settings, finger-sized.
    await page.getByRole('banner').getByRole('button', { name: /^Menu/ }).tap();
    const sheet = page.getByRole('menu', { name: 'Menu' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('group', { name: 'Pages' }).getByRole('menuitem', { name: 'Clubs' })).toBeVisible();
    // Help and the settings start folded so the sheet fits; a tap opens a group.
    await expect(sheet.getByRole('menuitem', { name: /^Tour: / })).toHaveCount(0);
    await sheet.getByRole('button', { name: /^Help/ }).tap();
    await expect(sheet.getByRole('menuitem', { name: /^Tour: / }).first()).toBeVisible();
    await sheet.getByRole('button', { name: /^Look/ }).tap();
    const sheetBox = (await sheet.boundingBox())!;
    expect(Math.round(sheetBox.y + sheetBox.height)).toBe(page.viewportSize()!.height);
    expect(await noSidewaysScroll(page)).toBe(true);
    expect(await smallTapTargets(page)).toEqual([]);
    await sheet.getByRole('menuitem', { name: 'Light or dark' }).tap();

    // Settings.
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    expect(await smallTapTargets(page)).toEqual([]);
    await page.getByRole('radio', { name: 'Dark' }).tap();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // About, help and login.
    for (const path of ['/about', '/help']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(await noSidewaysScroll(page), path).toBe(true);
      expect(await smallTapTargets(page), path).toEqual([]);
    }

    // The public link: the whole layout fits and a pinch zooms it.
    const { token } = (await (await page.request.post(`/api/layouts/${id}/public-share`)).json()) as { token: string };
    await page.context().clearCookies();
    await page.goto(`/p/${token}`);
    await expect.poll(() => stageInfo(page).then((s) => s.bricks), { timeout: 15000 }).toBeGreaterThan(100);
    // The fit lands just after the first paint.
    await expect.poll(() => stageInfo(page).then((s) => s.box.x2 <= s.width && s.box.y2 <= s.height)).toBe(true);
    const s = await stageInfo(page);
    expect(s.height).toBeGreaterThan(vp.height - 2); // the whole screen, not the window minus a toolbar
    expect(s.box.x1).toBeGreaterThanOrEqual(0);
    expect(s.box.x2).toBeLessThanOrEqual(s.width);
    expect(s.box.y1).toBeGreaterThanOrEqual(0);
    expect(s.box.y2).toBeLessThanOrEqual(s.height);
    expect(await noSidewaysScroll(page)).toBe(true);
    expect(await smallTapTargets(page)).toEqual([]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/mobile-test-public.png` });
    // Turned sideways before touching it: fits again.
    await page.setViewportSize({ width: vp.height, height: vp.width });
    await expect
      .poll(() => stageInfo(page).then((i) => i.width === vp.height && i.box.x1 >= 0 && i.box.y1 >= 0 && i.box.x2 <= i.width && i.box.y2 <= i.height))
      .toBe(true);
    // A pinch zooms it.
    const z0 = (await stageInfo(page)).zoom;
    await pinchOut(page);
    expect((await stageInfo(page)).zoom / z0).toBeGreaterThan(3.5);
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
    await page.setViewportSize(vp);

    await page.goto('/login');
    await expect(page.locator('input[type=email]')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    expect(await smallTapTargets(page)).toEqual([]);
  });
});
