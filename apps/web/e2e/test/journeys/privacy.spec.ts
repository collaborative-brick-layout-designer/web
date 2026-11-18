// Journey — your data, and changing your mind about deleting your account.
//
// Priya downloads her data from Profile › Your data: it's made in the
// background, the page shows Download when it's ready, and the zip holds
// a README and her layout. Then she deletes her account: the page says
// what goes and what stays, she types her email, she's signed out and the
// sign-in page says when it will go. She signs back in, and her account
// and her layout are still there, with a note saying it was kept.

import { test, expect } from '@playwright/test';
import { PASS, signIn, fromSettingsMenu } from '../../helpers';

const ts = Date.now();
test.setTimeout(180_000);

test('a person downloads their data, deletes their account, and keeps it by signing back in', async ({ page }) => {
  const EMAIL = `j-privacy-${ts}@example.com`;
  const LAYOUT = `Priya's yard ${ts}`;
  await signIn(page, EMAIL, 'Priya');
  const made = await page.request.post('/api/layouts', { data: { title: LAYOUT } });
  expect(made.ok()).toBe(true);

  // ---- Download my data -----------------------------------------------------
  await page.goto('/');
  await fromSettingsMenu(page, 'Your data');
  await expect(page).toHaveURL(/\/profile#my-data$/);
  const section = page.locator('#my-data');
  await section.getByRole('button', { name: 'Download my data' }).click();
  const download = section.getByRole('link', { name: 'Download' });
  await expect(download).toBeVisible({ timeout: 30_000 });
  // Asked once today: the button waits.
  await expect(section.getByRole('button', { name: 'Download my data' })).toBeDisabled();
  await expect(section).toContainText('You can ask again after');
  const href = await download.getAttribute('href');
  const zip = await page.request.get(href!);
  expect(zip.ok()).toBe(true);
  expect(zip.headers()['content-type']).toBe('application/zip');
  const body = (await zip.body()).toString('latin1');
  expect(body).toContain('README.txt');
  expect(body).toContain(`layouts/${LAYOUT}.bld-layout`);
  // A note says it was ready.
  await expect(page.getByTestId('notification-badge')).toHaveText('1', { timeout: 15000 });
  await page.getByTestId('notification-bell').click();
  await expect(page.getByTestId('notification-panel').getByTestId('notification-item').first()).toContainText('is ready');
  await page.getByTestId('notification-panel').getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByTestId('notification-badge')).toHaveCount(0);
  await page.getByTestId('notification-panel').getByRole('button', { name: 'Close notifications' }).click();

  // ---- Delete my account ------------------------------------------------------
  await fromSettingsMenu(page, 'Delete my account');
  await page.locator('#delete-account').getByRole('button', { name: 'Delete my account…' }).click();
  const plan = page.getByTestId('delete-plan');
  await expect(plan).toContainText('1 layout');
  await expect(plan).toContainText(LAYOUT);
  await expect(plan).toContainText('14 days');
  const del = plan.getByRole('button', { name: 'Delete my account' });
  await expect(del).toBeDisabled();
  await plan.getByLabel('Type your email or name to confirm').fill(EMAIL);
  await del.click();

  // Signed out; the sign-in page says when, and how to keep it.
  await expect(page).toHaveURL(/\/login\?deleting=\d+/);
  await expect(page.getByTestId('deleting-notice')).toContainText('Sign in before then and everything is kept');
  expect((await page.request.get('/api/auth/me')).status()).toBe(200);
  expect((await (await page.request.get('/api/auth/me')).json()).user).toBeNull();

  // ---- Changed her mind: sign back in ----------------------------------------
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASS);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
  await page.getByTestId('notification-bell').click();
  await expect(page.getByTestId('notification-panel').getByTestId('notification-item').first()).toContainText('your account will not be deleted');
  await page.getByTestId('notification-panel').getByRole('button', { name: 'Close notifications' }).click();
  await page.goto('/');
  await expect(page.getByText(LAYOUT).first()).toBeVisible();
  const summary = await (await page.request.get('/api/me/deletion')).json();
  expect(summary.pending).toBeNull();
});
