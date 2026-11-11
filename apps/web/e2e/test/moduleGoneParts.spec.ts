// A part deleted at the same instant someone adds it to a module (the
// 11-11 checks): Alex makes a module of two parts while Sam deletes one of
// them. Alex's Wi-Fi drops for the moment, so the two changes cross. Once
// they meet, the module lists only the part that is still on the map, in
// both browsers' Modules panels and on the server.
// SHOTS_DIR=<dir> saves light and dark pictures of Sam's panel at the end.

import { test, expect, type Page } from '@playwright/test';
import { ensureUser, signIn, makeModule } from '../helpers';

const ts = Date.now();
const SAM = `gone-sam-${ts}@example.com`;
const ALEX = `gone-alex-${ts}@example.com`;
const PART = 'ts_narrowgauge_straight.8';
const NAME = `Siding ${ts % 10000}`;
const SHOTS = process.env.SHOTS_DIR;

/** Light and dark pictures, once every part has its picture. */
async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  const missing = await page.evaluate(() => {
    type N = { name: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st ? st.find((n) => n.name() === 'unresolved-part' || n.name() === 'brick-loading').length : -1;
  });
  expect(missing, 'parts without their picture').toBe(0);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

interface Brick {
  id: string;
  sx: number;
  sy: number;
}

function bricks(page: Page): Promise<Brick[]> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string; getAbsolutePosition: () => { x: number; y: number } };
    const st = (window as unknown as { Konva?: { stages: { container: () => HTMLElement; find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    if (!st) return [];
    const box = st.container().getBoundingClientRect();
    return st
      .find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-'))
      .map((n) => {
        const a = n.getAbsolutePosition();
        return { id: n.name().slice(6), sx: box.left + a.x, sy: box.top + a.y };
      });
  });
}

/** The layout's modules as the server has them. */
async function serverModules(page: Page, id: string): Promise<{ name: string; members: string[] }[]> {
  const r = await page.request.get(`/api/layouts/${id}/export.bbm.bld`);
  return r.ok() ? (((await r.json()) as { modules?: { name: string; members: string[] }[] }).modules ?? []) : [];
}

async function placePart(page: Page): Promise<void> {
  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
}

async function openModulesPanel(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel('Modules', { exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Modules', { exact: true })).toBeHidden();
}

test('a part deleted as it is put in a module drops out of the module’s list', async ({ page, browser }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await ensureUser(SAM, 'Sam');
  await ensureUser(ALEX, 'Alex');
  await signIn(page, SAM, 'Sam');
  const res = await page.request.post('/api/layouts', { data: { title: 'Gone parts' } });
  const { id } = (await res.json()) as { id: string };
  const invite = await page.request.post(`/api/layouts/${id}/invites`, { data: { email: ALEX, role: 'editor' } });
  const { token } = (await invite.json()) as { token: string };

  // Sam lays two pieces.
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  for (let i = 0; i < 2; i++) await placePart(page);
  await expect.poll(async () => (await bricks(page)).length).toBe(2);
  await openModulesPanel(page);

  // Alex opens the layout, with the Modules panel and the Make a module dialog loaded.
  const alexCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const alex = await alexCtx.newPage();
  await signIn(alex, ALEX, 'Alex');
  await alex.request.post(`/api/invites/${token}`);
  const preloaded = alex.waitForResponse((r) => r.url().includes('ModulesPanel'), { timeout: 30000 });
  await alex.goto(`/editor/${id}`);
  await expect(alex.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => (await bricks(alex)).length, { timeout: 15000 }).toBe(2);
  await openModulesPanel(alex);
  await preloaded;
  await alex.waitForLoadState('networkidle');

  // At the same instant: Alex makes a module of both parts while Sam deletes one.
  await alexCtx.setOffline(true);
  await alex.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await alex.keyboard.press('Control+a');
  await makeModule(alex, NAME);
  const row = (p: Page) => p.locator('li', { hasText: NAME });
  await expect(row(alex)).toContainText('2 parts');

  const [gone, kept] = await bricks(page);
  await page.mouse.click(gone!.sx, gone!.sy);
  await expect(page.locator('footer')).toContainText('selected: 1');
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await bricks(page)).length).toBe(1);

  // The changes meet.
  await alexCtx.setOffline(false);
  await expect.poll(async () => (await bricks(alex)).length, { timeout: 20000 }).toBe(1);

  // The module lists only the part that's still there: in both panels…
  await expect(row(page)).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(500);
  await shoot(page, 'module-gone-part');
  for (const p of [page, alex]) {
    await expect(row(p)).toBeVisible({ timeout: 20000 });
    await expect(row(p)).toContainText('1 part');
    await expect(row(p)).not.toContainText('2 parts');
  }
  // …and on the server.
  await expect
    .poll(async () => (await serverModules(page, id)).map((m) => `${m.name}:${m.members.join(',')}`), { timeout: 15000 })
    .toEqual([`${NAME}:${kept!.id}`]);
  // Picking the module from Sam's panel picks just that part.
  await row(page).getByText(NAME, { exact: true }).click();
  await expect(page.locator('footer')).toContainText('selected: 1');

  await alexCtx.close();
});
