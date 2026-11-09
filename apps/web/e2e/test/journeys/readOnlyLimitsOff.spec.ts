// Journey: read-only holds while usage limits are off.
//
//   Settings: the admin turns "Enforce usage limits" off and is told
//   read-only still holds → Heavy use: makes a member read-only (the ⓘ
//   explains it) → the member can't start a layout, and is told why in
//   plain words, but still sees their layouts → lifted, they can again.

import { test, expect } from '@playwright/test';
import { signIn, adminSection } from '../../helpers';
import { makeGlobalAdmin } from '../../dbHelpers';

const ts = Date.now();
const ADMIN = `j-ro-admin-${ts}@example.com`;
const MEMBER = `j-ro-member-${ts}@example.com`;

test('read-only holds while usage limits are off, and lifts again', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await signIn(page, ADMIN, 'RO Admin');
  makeGlobalAdmin(ADMIN);
  const member = await browser.newPage();
  await signIn(member, MEMBER, `RO Member ${ts}`);
  expect((await member.request.post('/api/layouts', { data: { title: `Kept ${ts}` } })).ok()).toBe(true);

  const before = (await (await page.request.get('/api/admin/limits')).json()) as { enforcedSetting?: boolean };
  try {
    // ── Settings: limits off; the switch says read-only still holds. ──
    await page.goto('/admin');
    await adminSection(page, 'settings');
    const enforce = page.getByLabel('Enforce usage limits');
    if (await enforce.isChecked()) await enforce.click();
    await expect(enforce).not.toBeChecked();
    await expect(page.getByTestId('limits-off')).toHaveText(/Read-only accounts and clubs stay read-only\./);

    // ── Heavy use: open the member, read the ⓘ, make them read-only. ──
    await adminSection(page, 'heavy');
    await page.getByRole('region', { name: /Top people/ }).getByRole('button', { name: `RO Member ${ts}` }).first().click();
    await expect(page.getByText('It holds even while usage limits are off.')).toBeVisible();
    await page.getByRole('button', { name: /Read-only accounts and clubs/ }).click();
    await expect(page.getByText(/Read-only always holds, even while “Enforce usage limits” is off/)).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Make read-only' }).click();
    await expect(page.getByRole('button', { name: 'Lift read-only' })).toBeVisible();

    // ── The member: no new layout, told why; their layouts are still there. ──
    await member.goto('/');
    await expect(member.getByText(`Kept ${ts}`).first()).toBeVisible();
    await member.getByRole('button', { name: 'New layout', exact: true }).first().click();
    await member.getByRole('dialog', { name: 'New layout' }).getByRole('button', { name: 'Create' }).click();
    await expect(member.getByText('Your account is read-only for now. Ask the site admin why.')).toBeVisible();

    // ── Lifted: they can start one again, limits still off. ──
    await page.getByRole('button', { name: 'Lift read-only' }).click();
    await expect(page.getByRole('button', { name: 'Make read-only' })).toBeVisible();
    expect((await member.request.post('/api/layouts', { data: { title: `After ${ts}` } })).status()).toBe(201);
  } finally {
    await page.request.patch('/api/admin/settings', { data: { limitsEnforced: before.enforcedSetting ?? true } });
    await member.close();
  }
});
