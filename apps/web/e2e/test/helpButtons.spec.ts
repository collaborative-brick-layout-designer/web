// The "?" help buttons in the editor: hovering a panel's "?" shows the
// one-sentence tooltip, clicking it opens the popover with more, and
// turning help buttons off in Settings hides every one of them.
// SHOTS_DIR=<dir> also saves a tooltip and a popover, light and dark.

import { test, expect, type Locator, type Page } from '@playwright/test';
import { signIn } from '../helpers';

const SHOTS = process.env.SHOTS_DIR;

async function openNewLayout(page: Page, email: string): Promise<void> {
  await signIn(page, email, 'Help Tester');
  const res = await page.request.post('/api/layouts', { data: { title: 'Help Buttons Layout' } });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/editor/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 });
}

/** A screenshot area around a "?" with room for what opens under it. */
async function around(el: Locator) {
  const b = (await el.boundingBox())!;
  const x = Math.max(0, Math.min(b.x - 380, 1440 - 560));
  const y = Math.max(0, b.y - 120);
  return { x, y, width: 560, height: 360 };
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('radio', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click();
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

test('a panel "?" shows a tooltip on hover and a popover on click; Settings can turn them off', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openNewLayout(page, `help-${Date.now()}@example.com`);

  const sheets = page.locator('[data-panel="layers"]');
  const help = sheets.getByRole('button', { name: 'Help: Sheets' });
  await expect(help).toBeVisible();

  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);

    // Hover: one sentence.
    await help.hover();
    const tip = page.getByRole('tooltip');
    await expect(tip).toHaveText('Sheets are see-through pages stacked on the map, to keep things apart.');
    await expect(help).toHaveAttribute('aria-describedby', (await tip.getAttribute('id'))!);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-help-tooltip-${theme}.png`, clip: await around(help) });

    // Click: the popover with more, Show me and Learn more.
    await help.click();
    const pop = page.getByRole('dialog', { name: 'Sheets' });
    await expect(pop).toBeVisible();
    await expect(pop).toContainText('Put track on one sheet and buildings on another.');
    await expect(pop.getByRole('button', { name: 'Show me' })).toBeVisible();
    await expect(pop.getByRole('link', { name: 'Learn more' })).toHaveAttribute('href', '/help#sheets');
    await expect(tip).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/web-help-popover-${theme}.png`, clip: await around(help) });

    // Esc closes it and puts focus back on the "?".
    await page.keyboard.press('Escape');
    await expect(pop).toHaveCount(0);
    await expect(help).toBeFocused();

    // Show me pulses the panel it explains.
    await help.click();
    await pop.getByRole('button', { name: 'Show me' }).click();
    await expect(sheets).toHaveClass(/help-pulse/);
    await page.mouse.move(700, 600);
  }

  // Settings > Show help buttons off: every "?" goes.
  expect(await page.locator('[data-help-key]').count()).toBeGreaterThan(5);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('switch', { name: 'Show help buttons' }).click();
  await expect(settings.getByRole('switch', { name: 'Show help buttons' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('[data-help-key]')).toHaveCount(0);
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('[data-help-key]')).toHaveCount(0);

  // The Help menu turns them back on.
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await page.getByRole('button', { name: 'Turn help buttons on' }).click();
  await expect(help).toBeVisible();
});
