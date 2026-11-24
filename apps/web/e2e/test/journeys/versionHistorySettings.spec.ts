// Journey — an admin's version history settings, end to end.
//
//   Admin › Backups › Version history: change a number (it is saved and
//   the server uses it) → switch the history off → the editor's Map › File
//   no longer has "Version history…", and the history page (opened by its
//   address) says it is switched off and offers no way to keep a version
//   → switch it on again → the entry is back.
//
// The setting is site-wide, so it is put back at the end even if a step fails.

import { test, expect } from '@playwright/test';
import { signIn, adminSection, mapMenu } from '../../helpers';
import { makeGlobalAdmin } from '../../dbHelpers';

const ts = Date.now();
const ADMIN = `j-vh-settings-${ts}@example.com`;

test('an admin changes the version history settings, and switching it off hides the entry', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, ADMIN, 'History Admin');
  makeGlobalAdmin(ADMIN);
  const res = await page.request.post('/api/layouts', { data: { title: `History settings ${ts}` } });
  expect(res.ok()).toBe(true);
  const { id } = (await res.json()) as { id: string };
  const settings = async () => (await (await page.request.get('/api/admin/version-history')).json()) as { enabled: boolean; limits: { key: string; value: number }[] };
  const limit = async (key: string) => (await settings()).limits.find((l) => l.key === key)!.value;

  try {
    await page.goto('/admin');
    await adminSection(page, 'backups');
    const section = page.getByTestId('admin-version-history');
    await expect(section).toBeVisible();

    // ── A number: saved, and the server uses it. ──
    await section.getByLabel('Minutes between automatic versions', { exact: true }).fill('15');
    await section.getByRole('button', { name: 'Save Minutes between automatic versions' }).click();
    await expect.poll(() => limit('autoMinutes')).toBe(15);
    await expect(section.getByRole('button', { name: 'Save Minutes between automatic versions' })).toBeDisabled();

    // ── Off: the editor's entry goes, the page says why. ──
    const on = section.getByTestId('admin-version-history-enabled');
    await expect(on).toBeChecked();
    await on.click();
    await expect.poll(async () => (await settings()).enabled).toBe(false);
    await page.goto(`/editor/${id}`);
    await expect(page.getByRole('button', { name: 'Map', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    await page.getByRole('menu').last().getByRole('menuitem', { name: 'File', exact: true }).click();
    await expect(page.getByRole('menu').last().getByRole('menuitem').first()).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Version history…', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.goto(`/editor/${id}/history`);
    await expect(page.getByTestId('history-off')).toContainText('switched off');
    await expect(page.getByRole('button', { name: 'Keep a version now' })).toHaveCount(0);

    // ── On again: the entry is back. ──
    await page.goto('/admin');
    await adminSection(page, 'backups');
    await section.getByTestId('admin-version-history-enabled').click();
    await expect.poll(async () => (await settings()).enabled).toBe(true);
    await page.goto(`/editor/${id}`);
    await mapMenu(page, 'File', 'Version history…');
    await expect(page).toHaveURL(new RegExp(`/editor/${id}/history$`));
    await expect(page.getByTestId('history-off')).toHaveCount(0);
  } finally {
    await page.request.patch('/api/admin/version-history', { data: { enabled: true, limits: { autoMinutes: null } } });
  }
});
