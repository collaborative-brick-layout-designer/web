// Journey (web #498): a layout its owner deletes stays on record.
//
//   A site admin has Admin › Audit log › Deleted layouts open. Ada renames
//   her layout and deletes it from Home: it shows in the admin's list at
//   once (no reload), by the name it had, with who deleted it. Open history
//   shows everything that happened to it, its delete in words.
//
// SHOTS=<dir> saves light and dark pictures of each step.

import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { adminSection, signIn } from '../../helpers';
import { makeGlobalAdmin } from '../../dbHelpers';

const ts = Date.now();
const ADMIN = `j-deleted-admin-${ts}@example.com`;
const ADA = `j-deleted-ada-${ts}@example.com`;
const TITLE = `Goods yard ${ts}`;
const SHOTS = process.env.SHOTS;

const streamOpen = (page: Page) => expect(page.locator('html')).toHaveAttribute('data-live', 'open', { timeout: 15000 });

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(SHOTS, `${name}-${scheme}.png`) });
  }
}

test('an owner’s deleted layout shows in Admin › Audit log › Deleted layouts, live, with its whole history', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signIn(page, ADMIN, 'Audit Admin');
  makeGlobalAdmin(ADMIN);
  await page.goto('/admin');
  await adminSection(page, 'audit');
  await page.getByRole('radio', { name: 'Deleted layouts' }).click();
  const list = page.getByTestId('deleted-layouts');
  await expect(list).toBeVisible();
  await page.getByText('ⓘ What’s this?').click();
  await expect(list).toContainText('Every layout deleted by its owner or by a site admin');
  await streamOpen(page);

  // Ada, elsewhere: makes a layout, renames it, deletes it from Home.
  const adaCtx = await browser.newContext();
  const ada = await adaCtx.newPage();
  await signIn(ada, ADA, 'Ada Owner');
  const { id } = (await (await ada.request.post('/api/layouts', { data: { title: `${TITLE} draft` } })).json()) as { id: string };
  expect((await ada.request.patch(`/api/layouts/${id}`, { data: { title: TITLE } })).ok()).toBe(true);
  await ada.goto('/');
  await ada.getByRole('button', { name: `More for ${TITLE}` }).first().click();
  await ada.getByRole('menuitem', { name: 'Delete' }).click();
  const dialog = ada.getByTestId('confirm-dialog');
  const typeIt = dialog.getByLabel(`Type ${TITLE} to confirm`);
  if (await typeIt.isVisible().catch(() => false)) await typeIt.fill(TITLE);
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(ada.getByTestId('toast')).toContainText(`Deleted “${TITLE}”`);
  await adaCtx.close();

  // The admin's list has it without a reload, by its last name, with who.
  const row = list.locator('tr', { hasText: TITLE });
  await expect(row).toBeVisible({ timeout: 15000 });
  await expect(row).toContainText('Ada Owner');
  await expect(row).toContainText('(owner)');
  await shot(page, 'deleted-layouts');
  await row.getByRole('button', { name: /Open history/ }).click();
  const history = page.getByTestId('layout-history');
  await expect(history).toContainText(`History of “${TITLE}”`);
  await expect(page.getByText(`Deleted the layout “${TITLE}”.`)).toBeVisible();
  await shot(page, 'deleted-layout-history');
  await history.getByRole('button', { name: '← Deleted layouts' }).click();
  await expect(list).toBeVisible();
});
