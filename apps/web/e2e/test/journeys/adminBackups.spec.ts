// Journey — a site admin's backups, end to end on a real server.
//
//   Admin › Backups → Back up now → the backup is listed → Download it →
//   a layout is made after it → upload the downloaded file (it is checked
//   and listed as Uploaded) → Restore… it, typing RESTORE → the site
//   restarts and the page comes back by itself → the layout made after
//   the backup is gone, the one before it is there, a "Before a restore"
//   backup of the site as it was is listed, and the page says what happened.
//
// The test server runs in a restart loop (the e2e-stack action), as Docker
// restarts the real one: exit code 75 means "start again".

import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { signIn, adminSection } from '../../helpers';
import { makeGlobalAdmin } from '../../dbHelpers';

const ts = Date.now();
const ADMIN = `j-backups-${ts}@example.com`;

test('an admin backs up the site, downloads it, uploads it again and restores it', async ({ page }, info) => {
  test.setTimeout(240_000);
  await signIn(page, ADMIN, 'Backup Admin');
  makeGlobalAdmin(ADMIN);
  expect((await page.request.post('/api/layouts', { data: { title: `Kept ${ts}` } })).ok()).toBe(true);

  await page.goto('/admin');
  await adminSection(page, 'backups');
  await expect(page.getByRole('heading', { name: 'Backups', exact: true })).toBeVisible();

  // ── Back up now: listed when it's done, without reloading. ──
  const listed = async () => ((await (await page.request.get('/api/admin/backups')).json()) as { files: { name: string }[] }).files.map((f) => f.name);
  const known = new Set(await listed());
  await page.getByRole('button', { name: 'Back up now' }).click();
  let name = '';
  await expect
    .poll(async () => (name = (await listed()).find((n) => n.startsWith('cbld-manual-') && !known.has(n)) ?? ''), { timeout: 60_000 })
    .not.toBe('');
  // The page shows it without a reload (the live hint when it's done).
  const row = page.locator(`tr[data-backup="${name}"]`);
  await expect(row).toContainText('Made by hand');

  // ── Download it. ──
  const [download] = await Promise.all([page.waitForEvent('download'), row.getByRole('link', { name: `Download ${name}` }).click()]);
  expect(download.suggestedFilename()).toBe(name);
  const saved = info.outputPath(name);
  await download.saveAs(saved);
  expect(readFileSync(saved).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));

  // Something made after the backup, which the restore takes away.
  expect((await page.request.post('/api/layouts', { data: { title: `Gone ${ts}` } })).ok()).toBe(true);

  // ── Upload it: checked, then listed as Uploaded. ──
  await page.getByLabel('Database backup file').setInputFiles(saved);
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect(page.getByText(/Uploaded and checked: \d+ (person|people), /)).toBeVisible({ timeout: 60_000 });
  const uploaded = page.locator('tr[data-backup^="cbld-upload-"]').first(); // newest first
  await expect(uploaded).toContainText('Uploaded');
  const uploadedName = (await uploaded.getAttribute('data-backup'))!;

  // ── Restore it: plain warnings, typed confirmation. ──
  await uploaded.getByRole('button', { name: `Restore ${uploadedName}` }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Every change people made since then is replaced');
  await expect(dialog).toContainText('a backup of the site as it is right now is made');
  const go = dialog.getByRole('button', { name: 'Restore and restart' });
  await expect(go).toBeDisabled();
  await dialog.getByLabel('Type RESTORE to confirm').fill('RESTORE');
  await go.click();
  await expect(page.getByRole('status').filter({ hasText: `Restoring ${uploadedName}` })).toBeVisible();

  // ── The site restarts; the page comes back by itself and says so. ──
  await expect(page.getByText(new RegExp(`Restored the database from ${uploadedName.replace(/\./g, '\\.')}`))).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('tr[data-backup^="cbld-before-restore-"]').first()).toContainText('Before a restore');

  const layouts = (await (await page.request.get('/api/layouts')).json()) as { layouts?: { title: string }[] } | { title: string }[];
  const titles = (Array.isArray(layouts) ? layouts : (layouts.layouts ?? [])).map((l) => l.title);
  expect(titles).toContain(`Kept ${ts}`);
  expect(titles).not.toContain(`Gone ${ts}`);
});
