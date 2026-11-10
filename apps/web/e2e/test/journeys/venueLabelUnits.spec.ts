// The Venue Designer's wall labels ("North — 40.00 ft") follow the Units
// pick (area 7 part B, 2026-11-10). They used to say feet whatever was
// chosen, next to a status bar that said metres.

import { test, expect, type Page } from '@playwright/test';
import { signIn } from '../../helpers';

/** What the wall labels say, as drawn. */
function wallLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type N = { name: () => string; className: string; getAttr: (k: string) => unknown; find: (f: (n: N) => boolean) => N[] };
    const st = (window as unknown as { Konva: { stages: N[] } }).Konva.stages[0]!;
    return st
      .find((n) => n.name() === 'venue-label')
      .flatMap((g) => g.find((n) => n.className === 'Text').map((t) => String(t.getAttr('text'))));
  });
}

test('wall labels follow the chosen units', async ({ page }) => {
  await signIn(page, `venue-units-${Date.now()}@example.com`, 'Venue Units');
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
  const walls = (a: string, b: string) => [`north wall — ${a}`, `east wall — ${b}`, `south wall — ${a}`, `west wall — ${b}`];
  await expect.poll(() => wallLabels(page)).toEqual(walls('40.00 ft', '20.00 ft'));

  const units = page.locator('label:has-text("Units") select');
  await units.selectOption('m');
  await expect(page.getByText(/^Venue 12\.19 m × 6\.10 m/)).toBeVisible();
  await expect.poll(() => wallLabels(page)).toEqual(walls('12.19 m', '6.10 m'));

  await units.selectOption('studs');
  await expect.poll(() => wallLabels(page)).toEqual(walls('1523.9 studs', '762 studs'));

  await units.selectOption('ftin');
  await expect.poll(() => wallLabels(page)).toEqual(walls('40.00 ft', '20.00 ft'));
});
