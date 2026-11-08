// The Venue Designer's canvas follows the app's theme: in the dark theme its
// background and grid are dark and the walls are drawn light, and back in
// the light theme it is white with dark walls. It used to stay white.

import { test, expect, type Page } from '@playwright/test';
import { signIn } from '../../helpers';

/** The canvas's corner pixel, and the colors its background and walls are drawn in. */
function canvasLook(page: Page): Promise<{ corner: number[]; background: string; walls: string[] }> {
  return page.evaluate(() => {
    type N = { name: () => string; className: string; getAttr: (k: string) => unknown; getLayer: () => { getCanvas: () => { _canvas: HTMLCanvasElement } } };
    const st = (window as unknown as { Konva: { stages: { find: (f: (n: N) => boolean) => N[] }[] } }).Konva.stages[0]!;
    const bg = st.find((n) => n.name() === 'venue-canvas-background')[0]!;
    const canvas = bg.getLayer().getCanvas()._canvas;
    const corner = Array.from(canvas.getContext('2d')!.getImageData(2, 2, 1, 1).data).slice(0, 3);
    // Walls: the thick (7 px) outline lines of the room.
    const walls = st.find((n) => n.className === 'Line' && n.getAttr('strokeWidth') === 7).map((n) => String(n.getAttr('stroke')));
    return { corner, background: String(bg.getAttr('fill')), walls };
  });
}

test('the Venue Designer canvas follows the dark and light themes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await signIn(page, `venue-theme-${Date.now()}@example.com`, 'Venue Theme');
  await page.goto('/venues/new');
  await expect(page.getByRole('navigation', { name: 'Tools', exact: true })).toBeVisible();

  // A 40' x 20' room.
  await page.keyboard.press('r');
  const box = (await page.getByTestId('venue-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
  for (const ch of "40'x20'") await page.keyboard.press(ch);
  await page.keyboard.press('Enter');
  await expect(page.getByText('Venue 40′ 0″ × 20′ 0″')).toBeVisible();

  await expect.poll(async () => (await canvasLook(page)).walls.length).toBe(4);
  const dark = await canvasLook(page);
  expect(dark.background).toBe('rgb(27,30,35)');
  expect(Math.max(...dark.corner)).toBeLessThan(60);
  expect(new Set(dark.walls)).toEqual(new Set(['rgb(225,225,225)']));

  // Switching the theme with the designer open redraws it.
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(async () => (await canvasLook(page)).background).toBe('rgb(255,255,255)');
  const light = await canvasLook(page);
  expect(Math.min(...light.corner)).toBeGreaterThan(240);
  expect(new Set(light.walls)).toEqual(new Set(['rgb(30,30,30)']));
});
