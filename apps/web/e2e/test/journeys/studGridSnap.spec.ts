// Snapping to the stud grid: a part dragged a fraction of a stud lands with
// its snap corner on the nearest stud, wherever it was grabbed; the arrow
// keys move it to the next stud; "Move in steps" keeps an off-grid part off
// the grid by the same amount; the stud grid's lines show when zoomed in
// and turn off from the toolbar, and Settings shows the same choices.

import { test, expect, type Page } from '@playwright/test';
import { signIn } from '../../helpers';

test.use({ viewport: { width: 1440, height: 900 } });

type Stage = { x: () => number; y: () => number; scaleX: () => number; findOne: (s: string) => { getAttr: (k: string) => unknown } | undefined; draw: () => void };

/** The stage's pan and scale (screen px a scene px). */
function view(page: Page): Promise<{ x: number; y: number; scale: number }> {
  return page.evaluate(() => {
    const st = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0]!;
    return { x: st.x(), y: st.y(), scale: st.scaleX() };
  });
}

/** Whether the grid's last draw put the stud lines in. */
function studGridDrawn(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const st = (window as unknown as { Konva: { stages: Stage[] } }).Konva.stages[0]!;
    st.draw();
    return st.findOne('.grid-lines')?.getAttr('studGridDrawn') ?? null;
  });
}

test('parts land on the nearest stud, step mode keeps their offset, and the stud grid shows', async ({ page }) => {
  await signIn(page, `stud-grid-${Date.now()}@example.com`, 'Stud Grid');
  const res = await page.request.post('/api/layouts', { data: { title: 'Stud grid' } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  /** The first part's snap corner (the 9V straight's is half a stud in), from the saved layout. */
  const corner = async (): Promise<{ x: number; y: number } | null> => {
    const bbm = await (await page.request.get(`/api/layouts/${id}/export.bbm`)).text();
    const m = /<Brick id=[\s\S]*?<DisplayArea>\s*<X>([-\d.E]+)<\/X>\s*<Y>([-\d.E]+)<\/Y>/.exec(bbm);
    return m ? { x: Number(m[1]) + 0.5, y: Number(m[2]) } : null;
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;

  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });

  // Out of the box: snap on, a stud at a time, on the grid, stud lines shown.
  await expect(page.getByTestId('toolbar-snap-step')).toHaveValue('1');
  await expect(page.getByTestId('toolbar-snap-mode')).toHaveValue('grid');
  await expect(page.getByTestId('toolbar-stud-grid')).toBeChecked();

  await page.getByPlaceholder('Search parts (name or number)').fill('2865.8');
  await page.locator('aside li button[draggable="true"]').filter({ has: page.locator('img') }).first().dblclick();
  await expect.poll(corner).not.toBeNull();
  const placed = (await corner())!;
  expect(near(placed.x, Math.round(placed.x)) && near(placed.y, Math.round(placed.y))).toBe(true);

  const box = (await page.locator('.konvajs-content').first().boundingBox())!;
  /** The screen point of a map point (studs). */
  const screen = async (p: { x: number; y: number }) => {
    const v = await view(page);
    return { x: box.x + v.x + p.x * 8 * v.scale, y: box.y + v.y + p.y * 8 * v.scale };
  };
  const studPx = 8 * (await view(page)).scale;
  /** Drags the part (grabbed at `grab` studs from its corner) by (dx, dy) studs, slowly. */
  const dragBy = async (grab: { x: number; y: number }, dx: number, dy: number) => {
    const c = (await corner())!;
    const from = await screen({ x: c.x + grab.x, y: c.y + grab.y });
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx * studPx, from.y + dy * studPx, { steps: 12 });
    await page.mouse.up();
  };

  // A fraction of a stud, grabbed in two different places: the nearest stud each time.
  await dragBy({ x: 3, y: 4 }, 2.4, 1.3);
  await expect.poll(corner).toEqual({ x: placed.x + 2, y: placed.y + 1 });
  await dragBy({ x: 12.7, y: 2.2 }, -0.4, 0.7);
  await expect.poll(corner).toEqual({ x: placed.x + 2, y: placed.y + 2 });

  // The arrow keys: the next stud that way.
  await page.keyboard.press('ArrowRight');
  await expect.poll(corner).toEqual({ x: placed.x + 3, y: placed.y + 2 });

  // Snap off: a part goes exactly where it is let go, half a stud off.
  await page.getByTestId('toolbar-snap-step').selectOption('0');
  await dragBy({ x: 3, y: 4 }, 0.5, 0);
  await expect.poll(async () => near((await corner())!.x, placed.x + 3.5)).toBe(true);

  // Move in steps: whole steps from where it was, so it stays half a stud off.
  await page.getByTestId('toolbar-snap-step').selectOption('1');
  await page.getByTestId('toolbar-snap-mode').selectOption('steps');
  await dragBy({ x: 3, y: 4 }, 2.3, -0.2);
  await expect.poll(async () => near((await corner())!.x, placed.x + 5.5)).toBe(true);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => near((await corner())!.x, placed.x + 6.5)).toBe(true);

  // Back on the grid, the next arrow key puts it on a stud.
  await page.getByTestId('toolbar-snap-mode').selectOption('grid');
  await page.keyboard.press('ArrowRight');
  await expect.poll(corner).toEqual({ x: placed.x + 7, y: placed.y + 2 });

  // The stud lines show at this zoom, and turn off from the toolbar.
  await expect.poll(() => studGridDrawn(page)).toBe(true);
  await page.getByTestId('toolbar-stud-grid').uncheck();
  await expect.poll(() => studGridDrawn(page)).toBe(false);

  // Settings shows the same choices, and changes them.
  await page.goto('/settings');
  await expect(page.getByTestId('settings-snap-step')).toHaveValue('1');
  await expect(page.getByTestId('snap-mode-grid')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('switch', { name: 'Show the stud grid' })).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('snap-mode-steps').click();
  await page.getByRole('switch', { name: 'Show the stud grid' }).click();
  await page.goto(`/editor/${id}`);
  await expect(page.getByTestId('toolbar-snap-mode')).toHaveValue('steps');
  await expect(page.getByTestId('toolbar-stud-grid')).toBeChecked();
});
