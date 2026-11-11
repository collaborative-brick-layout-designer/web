// Journey — Admin › Site settings › Sign-in.
//
// A site admin finds how long people stay signed in, with a "?" that
// explains it. They shorten the website's "sign out when not used for" to
// 14 days and give the desktop app no longest; both stay after a reload.
// A longest shorter than the time unused is refused in plain words before
// anything is sent. Saving signs nobody out: the admin and a member who
// was already signed in both carry on. Everything goes back to the
// defaults at the end (the journeys share one server).

import { test, expect } from '@playwright/test';
import { adminSection, signIn } from '../../helpers';
import { makeGlobalAdmin, siteSettingsAtDefaults } from '../../dbHelpers';

siteSettingsAtDefaults();

const ts = Date.now();
const ADMIN = `j-signin-admin-${ts}@example.com`;
const MEMBER = `j-signin-member-${ts}@example.com`;

test('an admin changes how long sign-ins last, and nobody is signed out', async ({ page: admin, browser }) => {
  test.setTimeout(120_000);
  await signIn(admin, ADMIN, 'Sign-in Admin');
  makeGlobalAdmin(ADMIN);
  const memberCtx = await browser.newContext();
  const member = await memberCtx.newPage();
  await signIn(member, MEMBER, 'Sign-in Member');

  try {
    await admin.goto('/admin');
    await adminSection(admin, 'settings');
    const section = admin.getByTestId('sign-in-settings');
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByRole('heading', { name: /Sign-in/ })).toBeVisible();
    await expect(section.getByRole('group', { name: 'On the website' })).toBeVisible();
    await expect(section.getByRole('group', { name: 'In the desktop app' })).toBeVisible();
    await expect(section.getByTestId('sign-in-demo')).toHaveText('Demo visitors are signed out when their demo space’s time is up (1 hour by default).');

    // The "?" explains it.
    await section.getByRole('button', { name: 'Help: How long sign-ins last' }).click();
    await expect(admin.getByRole('dialog', { name: 'How long sign-ins last' })).toContainText('nobody is signed out when you save');
    await admin.keyboard.press('Escape');

    // The website: 14 days unused.
    const webIdle = section.getByTestId('sign-in-setting-webIdleHours');
    await expect(webIdle.getByRole('spinbutton')).toHaveValue('30');
    await webIdle.getByRole('spinbutton').fill('14');
    await webIdle.getByRole('button', { name: 'Save' }).click();
    await expect(webIdle.getByRole('button', { name: 'Back to the default (30 days)' })).toBeVisible();

    // A longest under the time unused: refused before anything is sent.
    const webMax = section.getByTestId('sign-in-setting-webMaxHours');
    await webMax.getByRole('spinbutton').fill('7');
    await expect(webMax.getByRole('alert')).toHaveText('Can’t be shorter than “sign out when not used for” (14 days).');
    await expect(webMax.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await webMax.getByRole('spinbutton').fill('90');

    // The desktop app: no longest.
    const deskMax = section.getByTestId('sign-in-setting-desktopMaxHours');
    await deskMax.getByRole('combobox').selectOption('never');
    await deskMax.getByRole('button', { name: 'Save' }).click();
    await expect(deskMax.getByRole('button', { name: 'Back to the default (180 days)' })).toBeVisible();

    // Both stay after a reload.
    await admin.reload();
    await adminSection(admin, 'settings');
    await expect(admin.getByTestId('sign-in-setting-webIdleHours').getByRole('spinbutton')).toHaveValue('14');
    await expect(admin.getByTestId('sign-in-setting-desktopMaxHours').getByRole('combobox')).toHaveValue('never');

    // Nobody was signed out: the admin and the member carry on.
    const meOf = async (p: typeof admin) => ((await (await p.request.get('/api/auth/me')).json()) as { user: { email: string } | null }).user?.email;
    expect(await meOf(admin)).toBe(ADMIN);
    expect(await meOf(member)).toBe(MEMBER);
  } finally {
    await admin.request.patch('/api/admin/settings', {
      data: { signIn: { webIdleHours: null, webMaxHours: null, desktopIdleHours: null, desktopMaxHours: null } },
    });
    await memberCtx.close();
  }
});
