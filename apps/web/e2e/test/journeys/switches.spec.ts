// Switches (trains design Phase 1): in Run mode a click on a switch flips
// it, the arrow shows the new way, and Undo takes the flip back; parts
// can't be moved. The setting is shared live with a second browser, kept
// when the layout opens again, set from the right-click menu while
// building, and the .bbm download says BlueBrick leaves it out.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { mapMenu, signIn } from '../../helpers';

const BBM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/bbm/tests/fixtures/tight-corner.bbm'), 'utf-8');
const GREEN = '#16A34A';
const ORANGE = '#EA580C';

interface Arrow {
  key: string;
  color: string;
  /** The heel, in page pixels. */
  x: number;
  y: number;
}

/** Every switch arrow as drawn: its key, color and where its heel is on the page. */
function arrows(page: Page): Promise<Arrow[]> {
  return page.evaluate(() => {
    type N = {
      name: () => string;
      getClassName: () => string;
      getAttr: (k: string) => unknown;
      find: (f: (n: N) => boolean) => N[];
      getAbsolutePosition: () => { x: number; y: number };
      getStage: () => { container: () => HTMLElement };
    };
    const stages = (window as unknown as { Konva: { stages: N[] } }).Konva.stages;
    const out: Arrow[] = [];
    for (const st of stages) {
      for (const g of st.find((n) => n.getClassName() === 'Group' && n.name().startsWith('switch-') && n.name() !== 'switch-arrows')) {
        const arrow = g.find((n) => n.getClassName() === 'Arrow')[0]!;
        const heel = g.find((n) => n.getClassName() === 'Circle')[0]!;
        const at = heel.getAbsolutePosition();
        const box = heel.getStage().container().getBoundingClientRect();
        out.push({ key: g.name().slice('switch-'.length), color: String(arrow.getAttr('stroke')), x: box.left + at.x, y: box.top + at.y });
      }
    }
    return out;
  });
}

async function arrowOf(page: Page, key: string): Promise<Arrow | undefined> {
  return (await arrows(page)).find((a) => a.key === key);
}

async function openLayout(page: Page, id: string) {
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
}

test('flip a switch in Run mode, undo it, and find it kept and shared', async ({ page, browser }) => {
  await signIn(page, `switches-${Date.now()}@example.com`, 'Switch Flipper');
  const created = await page.request.post('/api/layouts', { data: { title: 'Switches', bbm: BBM } });
  expect(created.ok()).toBe(true);
  const { id } = (await created.json()) as { id: string };
  await openLayout(page, id);

  // Building: no arrows until Run mode (or View › Switches).
  await expect.poll(async () => (await arrows(page)).length).toBe(0);
  await page.getByTestId('run-mode').click();
  await expect(page.getByTestId('run-mode-banner')).toContainText('click a switch to flip it');
  // The layout's monorail points and RC crossover each show an arrow, all the usual way.
  await expect.poll(async () => (await arrows(page)).length, { timeout: 20000 }).toBeGreaterThanOrEqual(5);
  const first = (await arrows(page)).find((a) => a.color === GREEN)!;
  expect(first).toBeTruthy();

  // A click on it flips it: the arrow turns orange (set the other way).
  await page.mouse.click(first.x, first.y);
  await expect.poll(async () => (await arrowOf(page, first.key))?.color).toBe(ORANGE);
  await expect(page.getByText(/^Switch set: /)).toBeVisible();

  // Undo takes the flip back; Redo puts it again.
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+z`);
  await expect.poll(async () => (await arrowOf(page, first.key))?.color).toBe(GREEN);
  await page.keyboard.press(`${mod}+Shift+z`);
  await expect.poll(async () => (await arrowOf(page, first.key))?.color).toBe(ORANGE);

  // Someone else on the layout sees the flip, live, and their flip comes back.
  const other = await browser.newContext();
  const theirs = await other.newPage();
  await theirs.context().addCookies(await page.context().cookies());
  await openLayout(theirs, id);
  await theirs.getByTestId('run-mode').click();
  await expect.poll(async () => (await arrowOf(theirs, first.key))?.color, { timeout: 20000 }).toBe(ORANGE);
  const back = (await arrowOf(theirs, first.key))!;
  await theirs.mouse.click(back.x, back.y);
  await expect.poll(async () => (await arrowOf(page, first.key))?.color, { timeout: 15000 }).toBe(GREEN);
  await theirs.mouse.click(back.x, back.y);
  await expect.poll(async () => (await arrowOf(page, first.key))?.color, { timeout: 15000 }).toBe(ORANGE);
  await other.close();

  // Stop: back to building, and the arrows go (View › Switches is off).
  await page.getByTestId('run-mode-banner').getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByTestId('run-mode-banner')).toHaveCount(0);
  await expect.poll(async () => (await arrows(page)).length).toBe(0);

  // Opened again: still set the other way (View › Switches shows it while building).
  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await mapMenu(page, 'View', 'Switches');
  await expect.poll(async () => (await arrowOf(page, first.key))?.color, { timeout: 20000 }).toBe(ORANGE);

  // While building, the right-click menu sets it: back to the usual way.
  const now = (await arrowOf(page, first.key))!;
  await page.keyboard.press('Escape');
  await page.mouse.click(now.x, now.y, { button: 'right' });
  const usual = page.locator('[data-ctx-menu]').getByRole('menuitemradio').first();
  await expect(usual).toHaveAttribute('aria-checked', 'false');
  await usual.click();
  await expect.poll(async () => (await arrowOf(page, first.key))?.color).toBe(GREEN);

  // Flip it again, and a .bbm download says BlueBrick leaves switch settings out.
  await page.mouse.click(now.x, now.y, { button: 'right' });
  await page.locator('[data-ctx-menu]').getByRole('menuitemradio').nth(1).click();
  await expect.poll(async () => (await arrowOf(page, first.key))?.color).toBe(ORANGE);
  await mapMenu(page, 'Download & export', 'Download as…');
  const dialog = page.getByRole('dialog', { name: 'Download As' });
  await dialog.getByLabel('BlueBrick map (.bbm)').check();
  await expect(dialog.getByText(/switch settings/)).toBeVisible();
});

test('Run mode keeps parts where they are', async ({ page }) => {
  await signIn(page, `switches-still-${Date.now()}@example.com`, 'Switch Flipper');
  const created = await page.request.post('/api/layouts', { data: { title: 'Switches still', bbm: BBM } });
  const { id } = (await created.json()) as { id: string };
  await openLayout(page, id);
  await page.getByTestId('run-mode').click();
  await expect.poll(async () => (await arrows(page)).length, { timeout: 20000 }).toBeGreaterThan(0);
  // A drag across the map moves nothing and picks nothing.
  const box = (await page.locator('canvas').first().boundingBox())!;
  const before = await page.evaluate(() => JSON.stringify((window as unknown as { Konva: { stages: { find: (s: string) => { name: () => string; x: () => number; y: () => number }[] }[] } }).Konva.stages[0]!.find('Group').filter((n) => n.name().startsWith('brick-')).map((n) => [n.name(), n.x(), n.y()])));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 80, { steps: 8 });
  await page.mouse.up();
  const after = await page.evaluate(() => JSON.stringify((window as unknown as { Konva: { stages: { find: (s: string) => { name: () => string; x: () => number; y: () => number }[] }[] } }).Konva.stages[0]!.find('Group').filter((n) => n.name().startsWith('brick-')).map((n) => [n.name(), n.x(), n.y()])));
  expect(after).toBe(before);
  // No right-click menu in Run mode either.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(page.locator('[data-ctx-menu]')).toHaveCount(0);
});
