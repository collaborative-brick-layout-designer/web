// E2E: pop-up notifications, as far as a browser test goes without a real
// push service: the bell panel's one-time offer (never on page load; Not
// now is remembered), Settings › Notifications' "Pop-ups in this browser"
// and the Pop-up choices, and the site switch in Admin › Settings that
// takes them all away. No push is sent anywhere.
// SHOTS_DIR=<dir> saves light and dark pictures of the offer and the settings.

import { test, expect, type Page } from '@playwright/test';
import { signIn, adminSection } from '../helpers';
import { makeGlobalAdmin, siteSettingsAtDefaults } from '../dbHelpers';

siteSettingsAtDefaults();

const ts = Date.now();
const SHOTS = process.env.SHOTS_DIR;

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('the bell offers pop-ups once; Settings has them; the site switch takes them away', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const ADMIN = `npush-admin-${ts}@example.com`;
  // A headless browser answers "denied" before anyone is asked; this one hasn't been asked yet, and then says "not now".
  await page.context().addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'default' });
    Notification.requestPermission = async () => 'default';
  });
  await signIn(page, `npush-${ts}@example.com`, 'Pop Up');
  await page.goto('/');
  // Nothing asked on page load.
  await expect(page.getByTestId('push-prompt')).toHaveCount(0);
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistration('/').then((r) => !!r))).toBe(false);
  await page.getByTestId('notification-bell').click();
  const prompt = page.getByTestId('push-prompt');
  await expect(prompt).toBeVisible();
  await shoot(page, 'after-push-prompt');
  await prompt.getByRole('button', { name: 'Not now' }).click();
  await expect(prompt).toHaveCount(0);
  await page.getByRole('button', { name: 'Close notifications' }).click();
  await page.getByTestId('notification-bell').click();
  await expect(page.getByTestId('notification-panel')).toBeVisible();
  await expect(page.getByTestId('push-prompt')).toHaveCount(0);

  // Settings: this browser, and a Pop-up choice per type.
  await page.goto('/settings#notifications');
  const devices = page.getByTestId('push-devices');
  await expect(devices).toContainText('Pop-ups in this browser');
  await expect(devices.getByRole('button', { name: 'Turn on here' })).toBeVisible();
  const clubs = page.getByTestId('notification-category-clubs');
  await clubs.locator('summary').click();
  await expect(clubs.getByRole('switch', { name: 'Requests to join a club you run: pop-up' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('switch', { name: 'Pause all pop-ups' })).toBeVisible();
  await shoot(page, 'after-push-settings');
  // The browser didn't allow it (a test browser answers no): it says so, and nothing is saved.
  await devices.getByRole('button', { name: 'Turn on here' }).click();
  await expect(devices.getByText(/weren’t allowed|blocking notifications/)).toBeVisible();
  expect(((await (await page.request.get('/api/push/subscriptions')).json()) as { subscriptions: unknown[] }).subscriptions).toEqual([]);

  // The site switch: off for everyone.
  const admin = await browser.newPage();
  await signIn(admin, ADMIN, 'Push Admin');
  makeGlobalAdmin(ADMIN);
  try {
    await admin.goto('/admin');
    await adminSection(admin, 'settings');
    const sw = admin.getByLabel('Pop-up notifications in browsers');
    await expect(sw).toBeChecked();
    await sw.click();
    await expect(sw).not.toBeChecked();
    await page.reload();
    await expect(page.getByTestId('notification-settings')).toBeVisible();
    await expect(page.getByTestId('push-devices')).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Pause all pop-ups' })).toHaveCount(0);
  } finally {
    await admin.request.patch('/api/admin/settings', { data: { pushEnabled: true } });
    await admin.close();
  }
});
