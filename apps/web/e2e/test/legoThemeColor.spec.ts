// Settings > Color: any LEGO color, found by its LEGO or BrickLink name or
// number, themes the app at once and follows the account; "The whole app"
// tints the header and page too; the extremes stay readable in light and
// dark; and a preset with "Just the highlights" is the original look again.

import { test, expect, type Page } from '@playwright/test';
import { signIn } from '../helpers';

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

const cssVar = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim().toUpperCase(), name);

async function pickLego(page: Page, search: string, name: RegExp) {
  const picker = page.getByTestId('lego-color-picker');
  await picker.getByRole('searchbox').fill(search);
  await picker.getByRole('radio', { name }).click();
  await expect(picker.getByRole('radio', { name })).toHaveAttribute('aria-checked', 'true');
}

test('any LEGO color themes the whole app, follows the account and stays readable', async ({ page }) => {
  await signIn(page, `lego-color-${Date.now()}@example.com`, 'Color Tester');
  await page.goto('/settings');
  await page.getByRole('radio', { name: 'Light', exact: true }).click();

  await page.getByTestId('lego-color-toggle').click();
  // Found by the BrickLink name, named both ways.
  await pickLego(page, 'dark blue', /^Earth Blue \(LEGO 140\), BrickLink: Dark Blue \(63\)/);
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-accent', 'lego');
  expect(await cssVar(page, '--accent')).toBe('#19325A');
  // No preset is checked any more; the LEGO tile names the color.
  await expect(page.getByRole('radio', { name: 'Brick red', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('lego-color-toggle')).toContainText('Earth Blue');

  // The whole app: header and page tinted.
  await page.getByTestId('color-style-full').click();
  await expect(html).toHaveAttribute('data-color-style', 'full');
  const header = page.locator('header.theme-chrome').first();
  await expect(header).toHaveCSS('background-color', 'rgb(218, 222, 229)'); // #DADEE5
  // Dark mode lightens the color so it reads on dark panels.
  await page.getByRole('radio', { name: 'Dark', exact: true }).click();
  await expect.poll(() => cssVar(page, '--accent')).toBe('#5C6D8A');
  await expect(header).toHaveCSS('background-color', 'rgb(44, 51, 60)'); // #2C333C

  await expect
    .poll(async () => (await (await page.request.get('/api/me/preferences')).json()).prefs, { timeout: 10_000 })
    .toMatchObject({ legoColor: 140, colorStyle: 'full', theme: 'dark' });

  // From the account alone after a reload.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(html).toHaveAttribute('data-accent', 'lego');
  await expect(html).toHaveAttribute('data-color-style', 'full');
  await expect.poll(() => cssVar(page, '--accent')).toBe('#5C6D8A');
  await expect(page.getByTestId('color-style-full')).toHaveAttribute('aria-checked', 'true');

  // The extremes, in both modes: the text on the accent, and accent text
  // on the panel, are WCAG AA.
  if (!(await page.getByTestId('lego-color-picker').isVisible())) await page.getByTestId('lego-color-toggle').click();
  for (const mode of ['Light', 'Dark']) {
    await page.getByRole('radio', { name: mode, exact: true }).click();
    const panel = await cssVar(page, '--panel');
    for (const [search, name] of [
      ['white', /^White \(LEGO 1\)/],
      ['black', /^Black \(LEGO 26\)/],
      ['24', /^Bright Yellow \(LEGO 24\)/],
      ['earth blue', /^Earth Blue \(LEGO 140\)/],
    ] as const) {
      await pickLego(page, search, name);
      const [main, ink, text] = [await cssVar(page, '--accent'), await cssVar(page, '--accent-ink'), await cssVar(page, '--accent-text')];
      expect(contrast(main, ink), `${search} ${mode}: text on the accent`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(text, panel), `${search} ${mode}: accent text`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(main, panel), `${search} ${mode}: the accent on the panel`).toBeGreaterThanOrEqual(3);
    }
  }

  // Back to the original look: a preset and just the highlights.
  await page.getByRole('radio', { name: 'Ocean blue', exact: true }).click();
  await page.getByTestId('color-style-original').click();
  await expect(html).toHaveAttribute('data-accent', 'ocean');
  await expect(html).toHaveAttribute('data-color-style', 'original');
  expect(await cssVar(page, '--accent')).toBe('#2459C4');
  await expect(header).toHaveCSS('background-color', 'rgb(31, 34, 38)'); // the dark panel
  await expect
    .poll(async () => (await (await page.request.get('/api/me/preferences')).json()).prefs, { timeout: 10_000 })
    .toMatchObject({ legoColor: null, accent: 'ocean', colorStyle: 'original' });
});
