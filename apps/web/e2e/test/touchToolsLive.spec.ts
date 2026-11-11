// The 11-11 touch check: Copy, Cut and Paste, measuring, and painting
// areas, by touch on a phone and on a tablet, with a computer's browser
// open on the same layout watching each change arrive live. The journeys
// (phoneClipboard, touchMeasurePaint) check the server; this checks a
// second person sees it as it happens, and the tablet's clipboard too.

import { test, expect, devices, type Browser, type CDPSession, type Page } from '@playwright/test';
import { signIn } from '../helpers';

const ts = Date.now();
const PART = 'ts_narrowgauge_straight.8';
const { defaultBrowserType: _p, ...pixel7 } = devices['Pixel 7'];
const { defaultBrowserType: _t, ...iPad } = devices['iPad (gen 7)'];
type Pt = { x: number; y: number };

// A person's taps are well over the editor's 200 ms undo grouping apart.
const human = (page: Page) => page.waitForTimeout(400);

class Finger {
  constructor(private cdp: CDPSession) {}
  static async on(page: Page): Promise<Finger> {
    return new Finger(await page.context().newCDPSession(page));
  }
  private send(type: string, pts: Pt[]) {
    return this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, id) => ({ x: p.x, y: p.y, id })) });
  }
  async tap(p: Pt) {
    await this.send('touchStart', [p]);
    await this.send('touchEnd', []);
  }
  async drag(from: Pt, to: Pt, steps = 16) {
    await this.send('touchStart', [from]);
    for (let i = 1; i <= steps; i++) {
      await this.send('touchMove', [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }]);
    }
    await this.send('touchEnd', []);
  }
}

/** What a page's map shows: parts, rulers and painted blue squares. */
function onMap(page: Page): Promise<{ parts: number; rulers: number; blue: number }> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string; getAttr: (k: string) => unknown };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    if (!st) return { parts: -1, rulers: -1, blue: -1 };
    const parts = st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length;
    const rulers = st.find((n) => /^ruler-(?!endpoint|scale)/.test(n.name())).length;
    const blue = st.find((n) => n.getClassName() === 'Rect' && /^rgba\(0, 96, 255,/.test(String(n.getAttr('fill') ?? ''))).length;
    return { parts, rulers, blue };
  });
}

async function moreActions(page: Page, action: string): Promise<void> {
  await page.getByTestId('touch-bar').getByRole('button', { name: 'More actions' }).tap();
  const more = page.getByRole('dialog', { name: 'More actions' });
  await expect(more).toBeVisible();
  await more.getByRole('button', { name: action, exact: true }).tap();
  await expect(more).toHaveCount(0);
}

async function openTool(page: Page, name: string): Promise<void> {
  await page.getByTestId('touch-bar').getByRole('button', { name: 'Measure and paint' }).tap();
  const sheet = page.getByRole('dialog', { name: 'Measure and paint' });
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(300); // (it slides up)
  await sheet.getByRole('button', { name: new RegExp(`^${name}`) }).tap();
  await expect(sheet).toHaveCount(0);
}

/** A computer's browser, signed in as the same person, open on the layout. */
async function watcher(browser: Browser, page: Page, id: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, storageState: await page.context().storageState() });
  const pc = await ctx.newPage();
  await pc.goto(`/editor/${id}`);
  await expect(pc.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  return pc;
}

async function check(page: Page, browser: Browser, device: 'phone' | 'tablet'): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page, `touch-live-${device}-${ts}@example.com`, 'Touch Live');
  const res = await page.request.post('/api/layouts', { data: { title: `Touch live ${device}` } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  if (device === 'phone') await page.getByTestId('mode-switch').getByRole('radio', { name: 'Edit' }).tap();
  const pc = await watcher(browser, page, id);
  const sees = (want: Partial<{ parts: number; rulers: number; blue: number }>, what: string) =>
    expect.poll(async () => {
      const m = await onMap(pc);
      return Object.entries(want).every(([k, v]) => m[k as keyof typeof m] === v) ? 'yes' : JSON.stringify(m);
    }, { timeout: 15000, message: `the computer sees ${what}` }).toBe('yes');
  const finger = await Finger.on(page);
  const bar = page.getByTestId('touch-bar');
  const map = (await page.getByTestId('canvas-area').boundingBox())!;
  const at = (fx: number, fy: number): Pt => ({ x: map.x + map.width * fx, y: map.y + map.height * fy });

  // ── A part, then Copy and Paste: the computer sees the copy arrive. ──
  await page.getByTestId('add-part').tap();
  const add = page.getByRole('dialog', { name: 'Add a part' });
  await add.getByRole('searchbox', { name: 'Search parts' }).fill('narrow gauge track straight 4 x 16');
  await add.locator(`[data-part-key="${PART}"]`).first().tap();
  await expect(bar).toHaveAttribute('aria-label', '1 picked');
  await sees({ parts: 1 }, 'the part');
  await human(page);
  await moreActions(page, 'Copy');
  await expect(page.getByText('Copied 1 part.', { exact: false })).toBeVisible();
  await human(page);
  await moreActions(page, 'Paste');
  await expect(page.getByText('Pasted 1 part.')).toBeVisible();
  await sees({ parts: 2 }, 'the pasted copy');

  // ── Cut takes the picked one off, for the computer too; Paste puts it back. ──
  await human(page);
  await moreActions(page, 'Cut');
  await expect(page.getByText(/^Cut 1 part\./)).toBeVisible();
  await sees({ parts: 1 }, 'the cut');
  await human(page);
  await bar.getByRole('button', { name: 'Paste' }).tap();
  await expect(page.getByText('Pasted 1 part.')).toBeVisible();
  await sees({ parts: 2 }, 'the pasted cut');
  await bar.getByRole('button', { name: 'Done' }).tap();
  await expect(bar).toHaveAttribute('aria-label', 'Touch editing');

  // ── Measure: tap, tap. The computer sees the ruler. ──
  await openTool(page, 'Measure a distance');
  await finger.tap(at(0.2, 0.75));
  await finger.tap(at(0.75, 0.75));
  await expect(bar).toHaveAttribute('aria-label', '1 picked');
  await sees({ rulers: 1 }, 'the ruler');
  await bar.getByRole('button', { name: 'Done' }).tap();

  // ── Paint a stroke of blue, then erase half of it: the computer follows. ──
  await openTool(page, 'Paint areas');
  const draw = page.getByTestId('touch-draw-bar');
  await draw.getByRole('radio', { name: 'Blue' }).tap();
  await finger.drag(at(0.2, 0.2), at(0.8, 0.2));
  await expect.poll(async () => (await onMap(page)).blue, { timeout: 10000 }).toBeGreaterThan(1);
  const painted = (await onMap(page)).blue;
  await sees({ blue: painted }, 'the painted squares');
  await draw.getByRole('radio', { name: 'Erase' }).tap();
  await finger.drag(at(0.15, 0.2), at(0.5, 0.2));
  await expect.poll(async () => (await onMap(page)).blue, { timeout: 10000 }).toBeLessThan(painted);
  const left = (await onMap(page)).blue;
  expect(left).toBeGreaterThan(0);
  await sees({ blue: left }, 'the erased squares');
  await draw.getByRole('button', { name: 'Done' }).tap();
  await expect(draw).toHaveCount(0);

  // ── Undo by touch takes the erase back, for the computer too. ──
  await page.getByRole('button', { name: 'Undo' }).tap();
  await sees({ blue: painted, parts: 2, rulers: 1 }, 'the undo');
  await pc.context().close();
}

test.describe('touch tools, live, on a phone', () => {
  test.use(pixel7);
  test('copy, cut and paste, measuring and painting reach a second browser', async ({ page, browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'touch through Chromium');
    test.setTimeout(180_000);
    await check(page, browser, 'phone');
  });
});

test.describe('touch tools, live, on a tablet', () => {
  test.use(iPad);
  test('copy, cut and paste, measuring and painting reach a second browser', async ({ page, browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'touch through Chromium');
    test.setTimeout(180_000);
    await check(page, browser, 'tablet');
  });
});
