// Journeys: changing a password on Profile, and "Forgot password?".
//
//   Change: Profile › Password, the ⓘ, a wrong current password is told
//   plainly, then the change keeps this browser signed in and signs the
//   other browser out.
//   Forgot: the sign-in page's "Forgot password?" → the emailed link (a
//   local mail sink) → choose a new one → signed in → the old password no
//   longer works, the new one does; the link doesn't work twice.

import { test, expect } from '@playwright/test';
import { PASS, signIn } from '../../helpers';
import { useSmtp } from '../../dbHelpers';
import { startMailSink } from '../../mailSink';

const ts = Date.now();
const NEW = 'a brand new passphrase';

test('change the password on Profile: other browsers are signed out, this one stays', async ({ page, browser }) => {
  const EMAIL = `j-pw-change-${ts}@example.com`;
  await signIn(page, EMAIL, 'Pat Change');
  // A second browser, signed in with the password.
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  expect((await otherPage.request.post('/api/auth/password/login', { data: { email: EMAIL, password: PASS } })).ok()).toBe(true);
  await otherPage.goto('/profile');
  await expect(otherPage.getByRole('heading', { name: 'Pat Change' })).toBeVisible();

  await page.goto('/profile');
  const section = page.getByTestId('change-password');
  await expect(section).toBeVisible();
  await page.getByRole('button', { name: 'Your password' }).click();
  await expect(page.getByText(/You need your current password to change it/)).toBeVisible();
  await page.keyboard.press('Escape');

  await section.getByLabel('Current password').fill('not my password');
  await section.getByLabel('New password', { exact: true }).fill(NEW);
  await section.getByLabel('New password again').fill(NEW);
  await section.getByRole('button', { name: 'Change password' }).click();
  await expect(section.getByRole('alert')).toHaveText('That isn’t your current password. Check it and try again.');

  await section.getByLabel('Current password').fill(PASS);
  await section.getByRole('button', { name: 'Change password' }).click();
  await expect(section.getByRole('status')).toHaveText('Password changed. You’re still signed in here; 1 other browser signed out.');

  // This browser: still in. The other: signed out.
  await page.reload();
  await expect(page.getByTestId('change-password')).toBeVisible();
  expect(((await (await otherPage.request.get('/api/auth/me')).json()) as { user: unknown }).user).toBeNull();
  expect((await otherPage.request.post('/api/auth/password/login', { data: { email: EMAIL, password: NEW } })).ok()).toBe(true);
  await other.close();
});

test('forgot password: the emailed link sets a new one and signs in, once', async ({ browser }) => {
  const EMAIL = `j-pw-forgot-${ts}@example.com`;
  const sink = await startMailSink();
  const restoreSmtp = useSmtp({ host: sink.host, port: sink.port, from: 'site@example.com' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await signIn(ctx, EMAIL, 'Fern Forgot');
    await ctx.clearCookies();

    // ── The sign-in page: Forgot password? ──
    await page.goto('/login');
    await page.getByRole('button', { name: 'Forgot password?' }).click();
    const form = page.getByTestId('forgot-password');
    await form.getByLabel('Email').fill(EMAIL);
    await form.getByRole('button', { name: 'Email me a link' }).click();
    await expect(form.getByRole('status')).toContainText('we’ve emailed it a link to choose a new password');

    // ── The email's link. ──
    const resets = () => sink.to(EMAIL).filter((m) => m.body.includes('/reset-password/'));
    await expect.poll(() => resets().length, { timeout: 15_000 }).toBe(1);
    const mail = resets()[0]!;
    const link = /https?:\/\/\S+\/reset-password\/[0-9a-f]{64}/.exec(mail.body)![0];
    const path = new URL(link).pathname;
    await page.goto(path);
    await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
    await page.getByLabel('New password', { exact: true }).fill(NEW);
    await page.getByLabel('New password again').fill(NEW);
    await page.getByRole('button', { name: 'Save new password' }).click();
    await expect(page.getByText(/Password changed\. You’re signed in here/)).toBeVisible();
    await expect(page).toHaveURL(/\/$/);

    // ── Signed in now; the old password is gone, the new one works. ──
    expect(((await (await page.request.get('/api/auth/me')).json()) as { user: { email: string } | null }).user?.email).toBe(EMAIL);
    const fresh = await browser.newContext();
    expect((await fresh.request.post('/api/auth/password/login', { data: { email: EMAIL, password: PASS } })).status()).toBe(401);
    expect((await fresh.request.post('/api/auth/password/login', { data: { email: EMAIL, password: NEW } })).ok()).toBe(true);
    await fresh.close();

    // ── The link doesn't work twice; the page says what to do. ──
    await ctx.clearCookies();
    await page.goto(path);
    await expect(page.getByRole('alert')).toHaveText(/doesn’t work any more/);
    await page.getByRole('link', { name: 'Ask for a new link' }).click();
    await expect(page.getByTestId('forgot-password')).toBeVisible();
  } finally {
    restoreSmtp();
    await sink.close();
    await ctx.close();
  }
});
