// Journey: a module in a layout acts as one piece. Sam groups three track
// pieces as a module; a click picks the whole module; a double-click opens
// Edit module (Alex, editing it too, shows on the bar); Sam moves one part
// on its own, presses Done, then recolors the module, and Alex sees the
// new color straight away. SHOTS=<dir> saves light and dark pictures.

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureUser, signIn, makeModule } from '../../helpers';

const ts = Date.now();
const SAM = `modedit-sam-${ts}@example.com`;
const ALEX = `modedit-alex-${ts}@example.com`;
const PART = 'ts_narrowgauge_straight.8';
const NAME = `Siding ${ts % 10000}`;
const SHOTS = process.env.SHOTS;

interface Brick {
  id: string;
  x: number;
  y: number;
  sx: number;
  sy: number;
}

function bricks(page: Page): Promise<Brick[]> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string; x: () => number; y: () => number; getAbsolutePosition: () => { x: number; y: number } };
    const st = (window as unknown as { Konva?: { stages: { container: () => HTMLElement; find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    if (!st) return [];
    const box = st.container().getBoundingClientRect();
    return st
      .find((n) => n.getClassName() === 'Group' && n.name().startsWith('brick-'))
      .map((n) => {
        const a = n.getAbsolutePosition();
        return { id: n.name().slice(6), x: n.x() / 8, y: n.y() / 8, sx: box.left + a.x, sy: box.top + a.y };
      });
  });
}

/** The module's outline color as the map draws it. */
function frameStroke(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    type N = { name: () => string; getClassName: () => string; stroke: () => string };
    const st = (window as unknown as { Konva?: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva?.stages[0];
    return st?.find((n) => n.getClassName() === 'Rect' && n.name() === 'module-frame')[0]?.stroke() ?? null;
  });
}

const footer = (page: Page) => page.locator('footer');

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('a module is one piece, opens with Edit module, and its new color reaches the other browser', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await ensureUser(SAM, 'Sam');
  await ensureUser(ALEX, 'Alex');
  await signIn(page, SAM, 'Sam');
  const res = await page.request.post('/api/layouts', { data: { title: 'Module journey' } });
  const { id } = (await res.json()) as { id: string };
  const invite = await page.request.post(`/api/layouts/${id}/invites`, { data: { email: ALEX, role: 'editor' } });
  const { token } = (await invite.json()) as { token: string };

  // Sam lays three straight pieces in a row and groups them as a module.
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  for (let i = 0; i < 3; i++) {
    await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
    await page.locator(`[title*="(${PART})"]`).first().dblclick();
  }
  await expect.poll(async () => (await bricks(page)).length).toBe(3);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+a');
  await makeModule(page, NAME);
  await expect(page.getByText(`“${NAME}” is a module in this layout`)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(footer(page)).toContainText('no selection');

  // A click on any one part picks the whole module.
  const before = await bricks(page);
  await page.mouse.click(before[1]!.sx, before[1]!.sy);
  await expect(footer(page)).toContainText('selected: 3');

  // Alex opens the layout and edits the same module from its ⋯ menu.
  const alexCtx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const alex = await alexCtx.newPage();
  await signIn(alex, ALEX, 'Alex');
  await alex.request.post(`/api/invites/${token}`);
  await alex.goto(`/editor/${id}`);
  await expect(alex.locator('canvas').first()).toBeVisible({ timeout: 15000 });
  await expect.poll(async () => (await bricks(alex)).length, { timeout: 15000 }).toBe(3);
  await alex.getByRole('button', { name: 'Panels', exact: true }).click();
  await alex.getByLabel('Modules', { exact: true }).check();
  await alex.mouse.click(600, 700);
  await alex.getByRole('button', { name: `More for ${NAME}` }).click();
  await alex.getByTestId('module-menu-edit').click();
  await expect(alex.getByTestId('module-edit-bar')).toContainText(`Editing module ${NAME}`);

  // Sam double-clicks a part: Edit module, with Alex shown on the bar.
  await page.mouse.dblclick(before[2]!.sx, before[2]!.sy);
  const bar = page.getByTestId('module-edit-bar');
  await expect(bar).toContainText(`Editing module ${NAME}`);
  await expect(page.getByTestId('module-edit-others')).toHaveText('Alex is here too', { timeout: 10000 });
  await expect(footer(page)).toContainText('selected: 1');
  await shot(page, 'module-edit');

  // One part moves on its own, clear of the module: it asks whether to
  // take it out, and Cancel keeps it in. The others stay put.
  const moving = before[2]!;
  await page.mouse.move(moving.sx, moving.sy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(moving.sx, moving.sy + 12 * i);
  await page.mouse.up();
  await expect.poll(async () => (await bricks(page)).find((b) => b.id === moving.id)!.y).toBeGreaterThan(moving.y + 5);
  const ask = page.getByRole('alertdialog', { name: /Take this part out of/ });
  await expect(ask).toBeVisible();
  await shot(page, 'module-take-out');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  const after = await bricks(page);
  for (const b of before.filter((x) => x.id !== moving.id)) expect(after.find((a) => a.id === b.id)!.y).toBeCloseTo(b.y, 3);

  // Done: back to the whole layout, where a click picks the module again.
  await bar.getByRole('button', { name: 'Done' }).click();
  await expect(bar).toBeHidden();
  await page.mouse.click(before[0]!.sx, before[0]!.sy);
  await expect(footer(page)).toContainText('selected: 3');

  // Sam recolors the module from its ⋯ menu; Alex sees it at once.
  // Before: its own default color, the same in both browsers.
  const ownColor = await frameStroke(alex);
  expect(ownColor).toMatch(/^rgba\(\d+,\d+,\d+,0\.8\)$/);
  expect(ownColor).not.toBe('rgba(255,136,0,0.8)');
  expect(await frameStroke(page)).toBe(ownColor);
  // (The "is a module in this layout" note has gone: it sat where the click below closes Panels.)
  await expect(page.getByText(`“${NAME}” is a module in this layout`)).toBeHidden({ timeout: 10000 });
  await page.getByRole('button', { name: 'Panels', exact: true }).click();
  await page.getByLabel('Modules', { exact: true }).check();
  await page.mouse.click(700, 800);
  await page.getByRole('button', { name: `More for ${NAME}` }).click();
  await page.getByTestId('module-menu-look').click();
  await page.getByTestId('module-outline-color').fill('#ff8800');
  await shot(page, 'module-look');
  await page.getByRole('dialog', { name: `Module look: ${NAME}` }).getByRole('button', { name: 'Done' }).click();
  await expect.poll(() => frameStroke(page)).toBe('rgba(255,136,0,0.8)');
  await expect.poll(() => frameStroke(alex), { timeout: 10000 }).toBe('rgba(255,136,0,0.8)');

  await alexCtx.close();
});
