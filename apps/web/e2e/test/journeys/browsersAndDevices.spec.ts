// Journey: Profile › Browsers and devices.
//
//   Signed in on a laptop, a phone and a tablet: Profile lists all three,
//   this one marked → sign the phone out (it's signed out at once) →
//   "Sign out of my other browsers" signs the tablet out and keeps this one.

import { test, expect, type Browser } from '@playwright/test';
import { PASS, confirmInDialog, signIn } from '../../helpers';

const ts = Date.now();
const EMAIL = `j-devices-${ts}@example.com`;
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const TABLET = 'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

async function signedInWith(browser: Browser, userAgent: string) {
  const ctx = await browser.newContext({ userAgent });
  expect((await ctx.request.post('/api/auth/password/login', { data: { email: EMAIL, password: PASS } })).ok()).toBe(true);
  expect(((await (await ctx.request.get('/api/auth/me')).json()) as { user: unknown }).user).not.toBeNull();
  return ctx;
}
const isSignedIn = async (ctx: import('@playwright/test').BrowserContext) =>
  ((await (await ctx.request.get('/api/auth/me')).json()) as { user: unknown }).user !== null;

test('see every browser signed in, sign one out, then all the others', async ({ page, browser }) => {
  await signIn(page, EMAIL, 'Dev Ices');
  const phone = await signedInWith(browser, PHONE);
  const tablet = await signedInWith(browser, TABLET);
  try {
    await page.goto('/profile#devices');
    const list = page.getByRole('list', { name: 'Browsers signed in' });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list.getByRole('listitem').first()).toContainText('This browser');
    await expect(list.getByText('Safari on iPhone')).toBeVisible();
    await expect(list.getByText('Chrome on Android')).toBeVisible();

    // ── The ⓘ says what signing out does. ──
    await page.getByRole('button', { name: 'Browsers and devices' }).click();
    await expect(page.getByText(/Signing a browser out ends its sign-in at once/)).toBeVisible();
    await page.keyboard.press('Escape');

    // ── Sign the phone out. ──
    await page.getByRole('button', { name: /^Sign out Safari on iPhone/ }).click();
    await confirmInDialog(page);
    await expect(list.getByText('Safari on iPhone')).toHaveCount(0);
    expect(await isSignedIn(phone)).toBe(false);
    expect(await isSignedIn(tablet)).toBe(true);

    // ── Every other browser: the tablet goes, this one stays. ──
    await page.getByRole('button', { name: 'Sign out of my other browsers' }).click();
    await expect(page.getByText('1 other browser signed out. You’re still signed in here.')).toBeVisible();
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Sign out of my other browsers' })).toHaveCount(0);
    expect(await isSignedIn(tablet)).toBe(false);
    await page.reload();
    await expect(page.getByRole('list', { name: 'Browsers signed in' }).getByText('This browser')).toBeVisible();
  } finally {
    await phone.close();
    await tablet.close();
  }
});
