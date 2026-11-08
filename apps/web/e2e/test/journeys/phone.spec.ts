// Journey 5 — at the show, on a phone.
//
//   At home, on a computer, a member saves a view of their layout → at the
//   show, on a phone: Home → open the layout (View) → Edit → add a part,
//   turn it, delete it, Undo → add another → back to View → pick the saved
//   view → Share picture hands a PNG to the phone's share sheet → the
//   server has both parts.

import { test, expect, devices, type Page } from '@playwright/test';
import { signIn } from '../../helpers';

const ts = Date.now();
const EMAIL = `j-phone-${ts}@example.com`;
const TITLE = `Show layout ${ts}`;
const PART = 'ts_narrowgauge_straight.8';
const { defaultBrowserType: _p, ...pixel7 } = devices['Pixel 7'];

// A person's taps are well over the editor's 200 ms undo grouping apart;
// a test's are not, so it pauses like a person between separate actions.
const human = (page: Page) => page.waitForTimeout(400);

function brickCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-')).length : 0;
  });
}

function firstRotation(page: Page): Promise<number> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string; rotation: () => number };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st?.find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-'))[0]?.rotation() ?? NaN;
  });
}

async function addPart(page: Page): Promise<void> {
  await page.getByTestId('add-part').tap();
  const sheet = page.getByRole('dialog', { name: 'Add a part' });
  await sheet.getByRole('searchbox', { name: 'Search parts' }).fill('narrow gauge track straight 4 x 16');
  await sheet.locator(`[data-part-key="${PART}"]`).tap();
  await expect(sheet).toHaveCount(0);
}

test('a member uses and edits their layout on a phone at the show', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'touch through Chromium');
  test.setTimeout(240_000);

  // ── At home, on a computer: a layout with a saved view. ──
  const home = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await signIn(home, EMAIL, 'Phone Fan');
  const res = await home.request.post('/api/layouts', { data: { title: TITLE } });
  const { id } = (await res.json()) as { id: string };
  await home.goto(`/editor/${id}`);
  await expect(home.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await home.getByRole('group', { name: 'Tasks' }).getByRole('button', { name: 'Build' }).click();
  const views = home.getByRole('region', { name: 'Views' });
  await views.getByRole('button', { name: '+ Add view' }).click();
  await views.getByLabel('Name the view').fill('Station');
  await views.getByRole('button', { name: 'Add view', exact: true }).click();
  await expect(home.getByTestId('save-status')).toHaveText('Saved', { timeout: 15000 });
  const cookies = await home.context().cookies();
  await home.close();

  // ── At the show, on a phone that can share files. ──
  const phoneCtx = await browser.newContext({ ...pixel7 });
  await phoneCtx.addCookies(cookies);
  await phoneCtx.addInitScript(() => {
    const shared: { name: string; type: string }[] = [];
    (window as unknown as { __shared: typeof shared }).__shared = shared;
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d: { files?: File[] }) => !!d.files?.length });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (d: { files: File[] }) => { for (const f of d.files) shared.push({ name: f.name, type: f.type }); },
    });
  });
  const page = await phoneCtx.newPage();

  // Home → open it: View first, no editing controls.
  await page.goto('/');
  await page.getByRole('listitem').filter({ hasText: TITLE }).getByRole('link', { name: 'Open' }).tap();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  const sw = page.getByTestId('mode-switch');
  await expect(sw.getByRole('radio', { name: 'View' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('touch-bar')).toHaveCount(0);

  // Edit: add, turn, delete, Undo; add another.
  await sw.getByRole('radio', { name: 'Edit' }).tap();
  await addPart(page);
  await expect.poll(() => brickCount(page)).toBe(1);
  const before = await firstRotation(page);
  await human(page);
  await page.getByTestId('touch-bar').getByRole('button', { name: 'Turn right' }).tap();
  await expect.poll(() => firstRotation(page)).not.toBe(before);
  await human(page);
  await page.getByTestId('touch-bar').getByRole('button', { name: 'Delete' }).tap();
  await expect.poll(() => brickCount(page)).toBe(0);
  await human(page);
  await page.getByRole('button', { name: 'Undo' }).tap();
  await expect.poll(() => brickCount(page)).toBe(1);
  // Undo brings the part back picked, as BlueBrick does.
  await expect(page.getByTestId('touch-bar')).toHaveAttribute('aria-label', '1 picked');
  await human(page);
  await page.getByRole('button', { name: 'Undo' }).tap(); // the turn
  await expect.poll(() => firstRotation(page)).toBe(before);
  await page.getByTestId('touch-bar').getByRole('button', { name: 'Done' }).tap();
  await addPart(page);
  await expect.poll(() => brickCount(page)).toBe(2);

  // View, the saved view, and Share picture to the phone's share sheet.
  await sw.getByRole('radio', { name: 'View' }).tap();
  await page.getByTestId('editor-header').locator('h1').tap();
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'Station' }).tap();
  await expect(page.getByTestId('active-view')).toContainText('Showing Station');
  await page.getByTestId('editor-header').getByRole('button', { name: 'Share picture' }).tap();
  const sheet = page.getByTestId('share-picture');
  await sheet.getByText('Station', { exact: true }).tap();
  await expect(sheet.getByRole('img', { name: 'Picture of Station' })).toBeVisible({ timeout: 15000 });
  await sheet.getByRole('button', { name: 'Share picture' }).tap();
  await expect(sheet.getByRole('status')).toHaveText('Shared.');
  expect(await page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared)).toEqual([
    { name: `${TITLE} - Station.png`, type: 'image/png' },
  ]);

  // The server has both parts once the phone lets go.
  await page.close();
  const check = await phoneCtx.newPage();
  await expect
    .poll(async () => ((await (await check.request.get(`/api/layouts/${id}/export.bbm`)).text()).match(/<Brick /g) ?? []).length, { timeout: 15000 })
    .toBe(2);
  await phoneCtx.close();
});
