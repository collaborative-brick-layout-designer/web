// Journey: signing in with GitHub and with Google.
//
// Nina has never been here: "Continue with GitHub" from a club invite's
// sign-in page signs her up and brings her back where she was going, and
// her Profile shows GitHub linked. Ola does the same with Google. Ada
// already has an account with a password: her GitHub account has the
// same email, so signing in with it doesn't take her account over; it
// asks, and once she's signed in to her account she links GitHub from
// Profile. A Google account whose address Google hasn't confirmed is
// turned away with a reason, and so is a sign-in the person cancels.
//
// The providers are the e2e stand-in (e2e/oauthMock.ts): the server runs
// with OAUTH_MOCK_ORIGIN and test client ids (.github/workflows/journeys.yml).

import { test, expect, type Page } from '@playwright/test';
import { ensureUser, signIn } from '../../helpers';
import { OAuthMock } from '../../oauthMock';

const ts = Date.now();
const mock = new OAuthMock();

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

test.beforeAll(async () => {
  await mock.start();
});
test.afterAll(async () => {
  await mock.stop();
});

async function me(page: Page) {
  const res = await page.request.get('/api/auth/me');
  return ((await res.json()) as { user: { email: string; displayName: string; linkedProviders: string[] } | null }).user;
}

test.beforeEach(async ({ page }) => {
  const providers = (await (await page.request.get('/api/auth/providers')).json()) as { providers: { id: string; enabled: boolean }[] };
  test.skip(
    !providers.providers.find((p) => p.id === 'github')?.enabled || !providers.providers.find((p) => p.id === 'google')?.enabled,
    'GitHub and Google sign-in are off on this server (start it with the e2e OAuth env from journeys.yml)',
  );
});

test('a new person signs in with GitHub and lands where they were going', async ({ page }) => {
  const email = `j-oauth-nina-${ts}@example.com`;
  mock.next('github', { id: 100000 + (ts % 100000), login: `nina${ts}`, name: 'Nina Rails', email });
  await page.goto('/login?next=%2Fsettings');
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  expect(await me(page)).toMatchObject({ email, displayName: 'Nina Rails', linkedProviders: ['github'] });

  await page.goto('/profile');
  const github = page.locator('#sign-in li', { hasText: 'GitHub' });
  await expect(github.getByText('linked')).toBeVisible();
});

test('a new person signs in with Google', async ({ page }) => {
  const email = `j-oauth-ola-${ts}@example.com`;
  mock.next('google', { sub: `g-${ts}`, email, name: 'Ola Track' });
  await page.goto('/login');
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(/\/$/);
  expect(await me(page)).toMatchObject({ email, displayName: 'Ola Track', linkedProviders: ['google'] });
});

test('a GitHub account with an existing account’s email links only once that account says yes', async ({ page }) => {
  const email = `j-oauth-ada-${ts}@example.com`;
  await ensureUser(email, 'Ada');
  mock.next('github', { id: 200000 + (ts % 100000), login: `ada${ts}`, name: 'Ada GitHub', email });

  // Not signed in: the GitHub sign-in doesn't open her account.
  await page.goto('/login');
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/link$/);
  await expect(page.getByRole('heading', { name: 'Link this account?' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in to that account' })).toBeVisible();
  expect(await me(page)).toBeNull();

  // Signed in to her account (her password, here a session), she says yes.
  await signIn(page, email, 'Ada');
  await page.goto('/link');
  await expect(page.getByRole('heading', { name: 'Link GitHub to your account?' })).toBeVisible();
  await page.getByRole('button', { name: 'Link GitHub' }).click();
  await expect(page).toHaveURL(/\/profile#sign-in$/);
  await expect(page.locator('#sign-in li', { hasText: 'GitHub' }).getByText('linked')).toBeVisible();
  expect((await me(page))?.linkedProviders).toContain('github');

  // From now on GitHub signs her straight in.
  await page.context().clearCookies();
  mock.next('github', { id: 200000 + (ts % 100000), login: `ada${ts}`, name: 'Ada GitHub', email });
  await page.goto('/login');
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/$/);
  expect((await me(page))?.email).toBe(email);
});

test('an unconfirmed Google address, and a cancelled sign-in, say why on the sign-in page', async ({ page }) => {
  mock.next('google', { sub: `g-unverified-${ts}`, email: `j-oauth-unv-${ts}@example.com`, email_verified: false });
  await page.goto('/login');
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await expect(page).toHaveURL(/\/login\?error=email_not_verified$/);
  await expect(page.getByRole('alert')).toContainText('isn’t confirmed with the provider');
  expect(await me(page)).toBeNull();

  // Nobody queued: the stand-in answers as a provider does when the person cancels.
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await expect(page).toHaveURL(/\/login\?error=/);
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await me(page)).toBeNull();
});
