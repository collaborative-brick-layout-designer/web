// Journey 6 — the site admin's day, in the real setup (limits enforced).
//
//   Dashboard → Settings: limits on, one layout per person → a member hits
//   the limit and is told why in plain words → Heavy use finds them → make
//   them read-only, they are told, then lift it → Users: name a moderator,
//   who gets Moderation → Settings shows the oldest desktop allowed and the
//   catalogs.

import { test, expect } from '@playwright/test';
import { signIn, fromSettingsMenu, adminSection } from '../../helpers';
import { makeGlobalAdmin, siteSettingsAtDefaults } from '../../dbHelpers';

siteSettingsAtDefaults();

const ts = Date.now();
const ADMIN = `j-admin-${ts}@example.com`;
const MEMBER = `j-admin-member-${ts}@example.com`;
const MOD = `j-admin-mod-${ts}@example.com`;

test('an admin turns limits on, helps a heavy user, and names a moderator', async ({ page, browser }) => {
  test.setTimeout(240_000);
  await signIn(page, ADMIN, 'Site Admin');
  makeGlobalAdmin(ADMIN);
  const member = await browser.newPage();
  await signIn(member, MEMBER, `Heavy User ${ts}`);
  expect((await member.request.post('/api/layouts', { data: { title: `First ${ts}` } })).ok()).toBe(true);
  const moderator = await browser.newPage();
  await signIn(moderator, MOD, `Mod ${ts}`);

  const before = (await (await page.request.get('/api/admin/limits')).json()) as { enforcedSetting?: boolean };
  try {
    // ── The dashboard. ──
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();

    // ── Settings: enforce limits, one personal layout each. ──
    await adminSection(page, 'settings');
    const enforce = page.getByLabel('Enforce usage limits');
    if (!(await enforce.isChecked())) await enforce.click();
    await expect(enforce).toBeChecked();
    await page.getByLabel('Layouts per person').fill('1');
    await page.getByRole('button', { name: 'Save limits' }).click();
    await expect(page.getByText(/Saved\. New limits apply right away/)).toBeVisible();

    // ── The member reaches it and is told why, with what to do. ──
    await member.goto('/');
    await member.getByRole('button', { name: 'New layout', exact: true }).first().click();
    await member.getByRole('dialog', { name: 'New layout' }).getByRole('button', { name: 'Create' }).click();
    await expect(
      member.getByText('You have 1 layout, the most allowed. Delete one you don’t need, or ask the site admin for more.'),
    ).toBeVisible();

    // ── Heavy use finds them; read-only, then lifted. ──
    await adminSection(page, 'heavy');
    const people = page.getByRole('region', { name: /Top people/ });
    await people.getByRole('button', { name: `Heavy User ${ts}` }).first().click();
    await expect(page.getByRole('heading', { name: 'Use and limits' })).toBeVisible();
    await expect(page.getByText('1 of 1').first()).toBeVisible();
    await page.getByPlaceholder('Reason (optional)').fill('Too many uploads');
    await page.getByRole('button', { name: 'Make read-only' }).click();
    await expect(page.getByRole('button', { name: 'Lift read-only' })).toBeVisible();
    const blocked = await member.request.post('/api/orgs', { data: { name: `Nope ${ts}` } });
    expect(blocked.status()).toBe(403);
    expect(((await blocked.json()) as { message: string }).message).toMatch(/read-only/);
    await page.getByRole('button', { name: 'Lift read-only' }).click();
    await expect(page.getByRole('button', { name: 'Make read-only' })).toBeVisible();

    // ── Users: name a moderator; they get Moderation, not the admin pages. ──
    await page.goto('/admin');
    await adminSection(page, 'users');
    await page.getByLabel(`Moderator: ${MOD}`).click();
    await expect(page.getByLabel(`Moderator: ${MOD}`)).toBeChecked();
    await moderator.goto('/');
    await fromSettingsMenu(moderator, /^Moderation/);
    await expect(moderator.getByRole('navigation', { name: 'Admin sections' })).toHaveCount(0);

    // ── Settings: the oldest desktop allowed and the catalogs are there. ──
    await adminSection(page, 'settings');
    await expect(page.getByText('Oldest desktop allowed')).toBeVisible();
    await expect(page.getByLabel('Public module catalog')).toBeVisible();
    await expect(page.getByLabel('Enforce usage limits')).toBeChecked();

    // ── Background jobs are switches here; they stick. The server's own
    //    setup is listed, each with why it is set elsewhere. ──
    const backups = page.getByLabel('Nightly backups');
    await expect(backups).toBeChecked();
    await backups.click();
    await expect(backups).not.toBeChecked();
    await page.reload();
    await adminSection(page, 'settings');
    await expect(page.getByLabel('Nightly backups')).not.toBeChecked();
    await page.getByLabel('Nightly backups').click();
    await expect(page.getByLabel('Nightly backups')).toBeChecked();
    const setup = page.getByRole('region', { name: 'Server setup' });
    await expect(setup.getByText('Parts folder')).toBeVisible();
    await expect(setup.getByText('Google sign-in')).toBeVisible();
  } finally {
    // Shared test server: the site-wide value back, limits as they were.
    await page.request.patch('/api/admin/limits', { data: { layoutsPerUser: null } });
    await page.request.patch('/api/admin/settings', { data: { limitsEnforced: before.enforcedSetting ?? true } });
    await member.close();
    await moderator.close();
  }
});
