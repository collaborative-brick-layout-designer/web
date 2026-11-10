// Journey: the same words and order as the desktop app (full review, area 7).
//
//   Ada opens a layout: the browser tab names it, the parts panel lists
//   parts by name (as the desktop's grid does), the Map menu says
//   "Find & Replace…" and opens it, and the Budget's limit column says what
//   an empty box means. The help's shortcut list says which way R turns.
//   In the venue designer the floor area follows the units picked.
//
// SHOTS=<dir> saves light and dark pictures of each step.

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { signIn, mapMenu } from '../../helpers';

const ts = Date.now();
const ADA = `j-paritywords-ada-${ts}@example.com`;
const SHOTS = process.env.SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
  }
}

/** The parts panel's part names, top to bottom (the name, else the number: the tile's tooltip). */
async function captions(page: Page): Promise<string[]> {
  return page.locator('button[data-part-key]').evaluateAll((els) =>
    els.map((e) => {
      const tip = e.getAttribute('title') ?? '';
      return tip.includes('\n(') ? tip.slice(0, tip.indexOf('\n(')) : (e.getAttribute('data-part-key') ?? '');
    }),
  );
}

test.describe('the same words as the desktop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('tab title, parts by name, Find & Replace, the budget and the R key', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page, ADA, 'Ada Parity');
    const title = `Harbor ${ts}`;
    const res = await page.request.post('/api/layouts', { data: { title } });
    const { id } = (await res.json()) as { id: string };
    await page.goto(`/editor/${id}`);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });

    // The browser tab names the layout.
    await expect(page).toHaveTitle(`${title} · Collaborative Brick Layout Designer`);

    // Parts by name, as the desktop lists them.
    await expect.poll(async () => (await captions(page)).length, { timeout: 30000 }).toBeGreaterThan(20);
    const names = await captions(page);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    await shot(page, 'parts-by-name');

    // Find & Replace, by its own name.
    await mapMenu(page, 'Find & Replace…');
    await expect(page.getByRole('dialog', { name: /Find/ })).toBeVisible();
    await page.keyboard.press('Escape');

    // The budget says what an empty limit means, in plain words.
    await mapMenu(page, 'Budget', 'Edit budget…');
    const budget = page.getByRole('dialog', { name: 'Budget' });
    await expect(budget.getByRole('columnheader', { name: 'Limit (empty: no limit)' })).toBeVisible();
    await expect(budget.getByRole('button', { name: 'New' })).toHaveAttribute('title', 'Start again: remove every limit');
    await shot(page, 'budget-words');
    await budget.getByRole('button', { name: 'Close the budget' }).click();

    // Leaving the editor puts the site's own title back.
    await page.goto('/help');
    await expect(page).toHaveTitle('Collaborative Brick Layout Designer');
    await expect(page.getByText('Turn the selected pieces left (counterclockwise)')).toBeVisible();
    await expect(page.getByText('Turn them right (clockwise)')).toBeVisible();
  });

  test('the venue designer shows the floor area in the units picked', async ({ page }) => {
    await signIn(page, `j-paritywords-venue-${ts}@example.com`, 'Ada Venue');
    await page.goto('/venues/new');
    await expect(page.getByRole('navigation', { name: 'Tools', exact: true })).toBeVisible();
    // A 40' x 20' room.
    await page.keyboard.press('r');
    const box = (await page.getByTestId('venue-canvas').boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
    for (const ch of "40'x20'") await page.keyboard.press(ch);
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Venue 40′ 0″ × 20′ 0″ · 800 sq ft/)).toBeVisible();
    await page.getByRole('combobox', { name: 'Units', exact: true }).selectOption({ label: 'Meters' });
    await expect(page.getByText(/Venue 12\.19 m × 6\.10 m · 74\.3 m²/)).toBeVisible();
    await shot(page, 'venue-area-meters');
    await page.getByRole('combobox', { name: 'Units', exact: true }).selectOption({ label: 'Studs' });
    // The status line and the venue's Inspector both say it.
    await expect(page.getByText(/ square studs$/)).toHaveCount(2);
  });
});
