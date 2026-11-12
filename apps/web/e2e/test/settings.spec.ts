// Settings follow the account: switching to dark + ocean survives a
// reload and is stored on the server (GET /api/me/preferences), not
// only in this browser.

import { test, expect } from '@playwright/test';
import { signIn } from '../helpers';

test('dark theme and ocean color persist across a reload and on the account', async ({ page }) => {
  const email = `settings-${Date.now()}@example.com`;
  await signIn(page, email, 'Settings Tester');
  await page.goto('/settings');

  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  // The sync note names the server the page came from, whatever it is.
  const host = new URL(page.url()).host;
  await expect(page.getByTestId('settings-sync-note')).toContainText(`Synced with ${host}`);

  await page.getByRole('radio', { name: 'Dark' }).click();
  await page.getByRole('radio', { name: 'Ocean blue' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'ocean');

  // The write is debounced; wait until the account has it.
  await expect
    .poll(async () => (await (await page.request.get('/api/me/preferences')).json()).prefs, { timeout: 10_000 })
    .toMatchObject({ theme: 'dark', accent: 'ocean' });

  // Forget this browser's copy, so the reload has to come from the account.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: 'Ocean blue' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'ocean');
  const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(body).toBe('rgb(22, 24, 27)'); // --bg, dark
});

test('a color picked just before leaving the page is kept', async ({ page }) => {
  await signIn(page, `settings-leave-${Date.now()}@example.com`, 'Settings Leaver');
  await page.goto('/settings');
  await expect(page.getByTestId('settings-sync-note')).toBeVisible();

  // Pick a color and leave at once: no waiting for the debounced save.
  await page.getByRole('radio', { name: 'Ocean blue' }).click();
  await page.goto('/');

  // Forget this browser's copy, so what comes back is the account's.
  await page.evaluate(() => localStorage.clear());
  await page.goto('/settings');
  await expect(page.getByRole('radio', { name: 'Ocean blue' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'ocean');
});
