// Journey: a module save that meets a server restart goes through, calmly.
//
//   Ada adds a part to her module and presses Save module while the server
//   answers one 502 (faked: a restart, the proxy has nothing behind it),
//   then 200. A calm note says "Saving… the server is restarting, trying
//   again", no error is shown, and the save lands: the module's version
//   goes up by one and the status ends at "Saved".

import { test, expect } from '@playwright/test';
import { signIn } from '../../helpers';

const ts = Date.now();
const ADA = `j-modrestart-${ts}@example.com`;
const PART = 'ts_narrowgauge_straight.8';

test('a module save that gets one 502 is tried again and lands, with no error shown', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, ADA, 'Ada Restart');
  const { id } = (await (await page.request.post('/api/modules', { data: { title: `Restart ${ts}` } })).json()) as { id: string };
  await page.goto(`/modules/${id}`);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('save-status')).toHaveText('Saved');
  const version = async () => ((await (await page.request.get(`/api/modules/${id}`)).json()) as { module: { docVersion: number } }).module.docVersion;
  const before = await version();

  await page.getByPlaceholder('Search parts (name or number)').first().fill('narrow gauge track straight 4 x 16');
  await page.locator(`[title*="(${PART})"]`).first().dblclick();
  await expect(page.getByTestId('save-status')).not.toHaveText('Saved');

  // The first save attempt gets a 502, the next goes to the real server.
  let attempts = 0;
  await page.route(`**/api/modules/${id}/snapshot*`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad Gateway</h1>' });
    return route.continue();
  });
  await page.getByRole('button', { name: 'Save module' }).click();
  await expect(page.getByTestId('server-restart-note')).toHaveText('Saving… the server is restarting, trying again.');
  await expect(page.getByTestId('save-status')).toHaveText('Saved', { timeout: 20000 });
  await expect(page.getByTestId('server-restart-note')).toHaveCount(0);
  // No error anywhere, and the save landed once, on the second try.
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(attempts).toBe(2);
  expect(await version()).toBe(before + 1);
});
